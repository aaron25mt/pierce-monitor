exports.handler = (event, context, callback) => {
  const config = require("./config")
  const axios = require("axios")
  const cheerio = require("cheerio")
  const jsonDiff = require("json-diff")
  const AWS = require("aws-sdk")

  const SECONDS = 1000

  // DEV STUFF
  const fs = require("fs")
  const util = require("util")

  const debug = text => {
    if (config.DEBUG_MODE) console.log("[DEBUG] " + text)
  }

  const formatMoney = price => {
    return Number(price).toFixed(0).replace(/\d(?=(\d{3})+\.)/g, '$&,')
  }

  const getOldFloorPlans = async () => {
    debug("Retrieving old floor plans..")

    const s3 = new AWS.S3()
    const params = {
      Bucket: "pierce-monitor",
      Key: "floor-plans.json"
    }

    try {
      const response = await s3.getObject(params).promise()
      debug("Successfully retrieved old floor plans from S3..")
      return JSON.parse(response.Body.toString("utf-8"))
    } catch (error) {
      debug("Unable to retrieve old floor plans from S3..")
      debug(error)
      return []
    }
  }

  const publishUpdatedFloorPlans = async text => {
    debug("Uploading updated floor plans to S3...")

    const s3 = new AWS.S3()
    const params = {
      Bucket: "pierce-monitor",
      Key: "floor-plans.json",
      Body: text
    }

    try {
      const response = await s3.putObject(params).promise()
      debug("Successfully uploaded updated floor plans to S3!")
    } catch (error) {
      debug("Error uploading updated floor plans to S3..")
      debug(error)
      throw error
    }
  }

  const formatFloorPlansForSMS = floorPlans => {
    messageToSend = "\n"

    floorPlans.filter(plan => plan.availability).forEach(floorPlan => {
      messageToSend += floorPlan.name + " (sq. ft. " + floorPlan.square_footage + ")\n"
      floorPlan.availability.forEach(unit => {
        messageToSend += "Unit #" + unit.unit + " is available " + unit.available_on + " for $" + formatMoney(unit.price) + "\n"
      })
      messageToSend += "\n"
    })

    return messageToSend
  }

  const grabHTML = async () => {
    debug("Grabbing HTML..")

    try {
      const response = await axios.get(config.SITE_URL)
      debug("Successfully grabbed HTML")
      return response.data
    } catch (error) {
      debug("Failure grabbing HTML")
      throw error
    }
  }

  const parseFloorPlanInfo = floorPlanInfo => {
    const trimmed = floorPlanInfo.trim()
    const bulletSplit = trimmed.split('•')

    return {
      name: trimmed.split(' ').slice(0, 2).join(' ').trim(),
      square_footage: bulletSplit[bulletSplit.length - 1].split('Sq')[0].trim()
    }
  }

  const parseFloorPlanAvailability = floorPlanAvailability => {
    const fpaText = floorPlanAvailability.text()
    if (fpaText.search("No Plans Currently Available") != -1) return null

    const unitsElemList = floorPlanAvailability.find('.avail-row').toArray()
    if (unitsElemList.length < 2) return null

    const units = []

    unitsElemList.forEach((item, index) => {
      if (index == 0) return; // Templating row, ignore

      const $ = cheerio.load(item)
      const unitNum = $('.avail-unit .right').text()
      const unitAvailDate = $('.avail-date .right').text()
      const unitPrice = $('.avail-price .right').text()

      units.push({
        unit: unitNum,
        available_on: unitAvailDate,
        price: unitPrice
      })
    })

    return units
  }

  const parseFloorPlans = rawHTML => {
    debug("Parsing floor plans..")

    const $ = cheerio.load(rawHTML)

    const floorPlans = []
    const numFloorPlans = $('.onebed:nth-child(2) .accordion-content .accordionsub-container > a').length
    const floorPlansHTMLList = $('.onebed:nth-child(2) .accordion-content .accordionsub-container')

    for (i = 0; i < numFloorPlans; i++) {
      debug("Parsing info for floor plan #" + (i + 1))
      const floorPlanInfoText = $(floorPlansHTMLList.find('.accordionsub-toggle')[i]).text()
      const floorPlanAvailability = $(floorPlansHTMLList.find('.accordionsub-content')[i])

      const floorPlan = {
        ...parseFloorPlanInfo(floorPlanInfoText),
        availability: parseFloorPlanAvailability(floorPlanAvailability)
      }
      floorPlans.push(floorPlan)
    }

    return floorPlans
  }

  const publishToSNS = async message => {
    debug("Publishing message to SNS..")

    const sns = new AWS.SNS()
    const params = {
      Message: message,
      Subject: "Updated Availability at The Pierce",
      TopicArn: config.SNS_TOPIC
    }

    try {
      await sns.publish(params).promise()
      debug("Message successfully posted to SNS topic!")
    } catch (error) {
      debug("Error publishing to SNS topic..")
      debug(error)
      throw error
    }
  }

  // A function that keeps trying, "toTry" until it returns true or has
  // tried "max" number of times. First retry has a delay of "delay".
  // "next" is called upon success.
  const exponentialBackoff = async (toTry, max, delay, next) => {
    const result = await toTry()

    if (result) {
      next(true)
    } else {
      if (max <= 0) next(false)

      debug("Waiting " + ((delay * 2) / SECONDS) + " second(s) and trying again...")
      setTimeout(function() {
        exponentialBackoff(toTry, --max, delay * 2, next)
      }, delay)
    }
  }

  const scrape = async () => {
    debug("Attempting to scrape website..")

    try {
      const html = await grabHTML()
      const floorPlans = parseFloorPlans(html)
      const oldFloorPlans = await getOldFloorPlans()
      const newChanges = jsonDiff.diff(oldFloorPlans, floorPlans)

      if (newChanges) {
        debug("New changes to availability!")
        const formattedJSON = JSON.stringify(floorPlans, null, 4)
        await publishUpdatedFloorPlans(formattedJSON)
        await publishToSNS(formatFloorPlansForSMS(floorPlans))
      } else {
        debug("No new changes to availability :(")
      }
      return true
    } catch (error) {
      debug("Error scraping website..")
      console.log(error)
      return false
    }
  }

  const main = async () => {
    debug("Starting scraper...")

    AWS.config.update({
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      region: config.AWS_REGION
    })

    exponentialBackoff(scrape, 5, 30 * SECONDS, success => {
      if (!success) debug("Failure scraping site.")
      else debug("Successfully scraped site!")
    })
  }

  main()
}
