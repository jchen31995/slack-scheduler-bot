const axios = require('axios')
const _ = require('lodash')
const moment = require('moment')
const momentTZ = require('moment-timezone')

const { meetingAttachment, reminderAttachment } = require('./interactive_messages')
const { capitalizeString, getFormattedDate, getFormattedDuration } = require('./message_formatting')
const Meeting = require('../../models/Meeting')
const Task = require('../../models/Task')
const { getUserInfo, postMessage } = require('./web_client_methods')

const API_THROTTLE = 1000

// need to promisify this to line up async functions in app.js
const confirmMeeting = (payload) => {
  let confirmationMessage
  switch(payload.actions[0].value) {
    case('confirmed'):
      confirmationMessage = { text: 'Meeting Confirmed' }
      break

    case('declined'):
      confirmationMessage = { text: 'Meeting Declined' }
      break
  }
  return confirmationMessage
}

// need to promisify this to line up async functions in app.js
const confirmReminder = (payload) => {
  let confirmationMessage
  switch(payload.actions[0].value) {
    case('confirmed'):
      confirmationMessage = { text: 'Reminder Confirmed' }
      break

    case('declined'):
      confirmationMessage = { text: 'Reminder Declined' }
      break
  }
  return confirmationMessage
}

const displayWeather = _.throttle(async (result, message) => {
  const API_KEY = process.env.APIXU_KEY
  const weatherURL = 'http://api.apixu.com/v1/forecast.json'
  const weatherQuery = result.parameters.fields.query.stringValue

  const weatherLookUp = `${weatherURL}?key=${API_KEY}&q=${weatherQuery}&days=${5}`

  axios.get(weatherLookUp)
  .then((resp) => {
    const { location, current } = resp.data
    const { forecastday } = resp.data.forecast
    const week = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

    const fiveDayForecast = forecastday.map((forecast) => {
      const { date_epoch } = forecast
      const forecastDate = new Date(date_epoch * 1000)
      const month = forecastDate.getMonth()
      const date = forecastDate.getDate()
      const dayOfWeek = week[forecastDate.getDay()]
      const { maxtemp_f, mintemp_f } = forecast.day
      const { text } = forecast.day.condition
      return `\t ${ dayOfWeek } ${ month }/${ date } - ${ maxtemp_f }°F/${ mintemp_f }°F (${ text }) \n `
    })

    const forecastMessage =
      `*Here's the weather in ${ location.name }, ${ location.region }.* \n
      Current Weather:
      \t${ current.temp_f }°F (${ current.condition.text })
      \tSunrise: ${ forecastday[0].astro.sunrise }
      \tSunset: ${ forecastday[0].astro.sunset }

      Five Day Forecast:
      ${ fiveDayForecast.join('\t') }
      `
    return postMessage(message.channel, forecastMessage)
  })
  .catch((err) => postMessage(message.channel, `Sorry, I couldn't find that location. Please try again.`))
}, API_THROTTLE)

const handleUnexpectedEvent = () => 'This is some unknown event'

const promptMeeting = _.throttle(async (result, message) => {
  const meetingParameters = result.parameters.fields

  const date = meetingParameters.date.stringValue.split('T')[0]
  const startTimeString = date + 'T' + meetingParameters.time.stringValue.split('T')[1]
  const startTime = moment(startTimeString).toDate()
  const timeZone = momentTZ.tz.guess()
  const formattedDate = getFormattedDate(date)

  const defaultDuration = { amount: {numberValue: 30}, unit: {stringValue: 'minutes'} }

  let durationObjWithAdjustedUnit = Object.assign({},meetingParameters.duration.structValue)

  if (Object.keys(durationObjWithAdjustedUnit).length!==0) {
    durationObjWithAdjustedUnit = durationObjWithAdjustedUnit.fields
    if(meetingParameters.duration.structValue.fields.unit.stringValue[0]==='m'){
      durationObjWithAdjustedUnit.unit.stringValue = 'minutes'
    } else {
      durationObjWithAdjustedUnit.unit.stringValue = 'hours'
    }
  } else {
    durationObjWithAdjustedUnit = defaultDuration
  }
  const durationFields = durationObjWithAdjustedUnit || defaultDuration

  const momentEndTime = moment(startTime).add(durationFields.amount.numberValue, durationFields.unit.stringValue)
  const endTime = momentEndTime.toDate()
  const formattedDuration = getFormattedDuration(durationFields)


  // you can massage this invitees to include slack users
  let invitees = []
  const allInvitees = meetingParameters.invitees.listValue.values
  for (let i = 0; i < allInvitees.length; i++ ) {
    const currentUser = allInvitees[i].stringValue.trim()
    if(currentUser[0]==='<'){
      const slackId = currentUser[currentUser.length-1] === '>' ? currentUser.slice(2,currentUser.length-1) : currentUser.slice(2,currentUser.length)
      const { name, email } = await getUserInfo(slackId)
      invitees.push({ displayName: capitalizeString(name), email  })

    } else{
      invitees.push({ displayName: capitalizeString(currentUser), email: 'temp@slack.com' })
    }
  }

  const inviteesString = invitees.length > 1 ? invitees.map((person) => person.displayName).join(', ') : invitees[0].displayName
  const tempSubject = meetingParameters.subject.stringValue ? capitalizeString(meetingParameters.subject.stringValue) : 'Meeting'
  const subject = `${tempSubject !== 'A meeting'? tempSubject : 'Meeting'} with ${inviteesString}`
  const time = meetingParameters.time.stringValue
  const formattedTime = moment(time).format('LT')

  const scheduleConfirmationPrompt = `Scheduling: ${subject} on ${ formattedDate } at ${ formattedTime } for ${ formattedDuration }`

  const meetingRecord = {
    summary: subject,
    start: {dateTime: startTime, timeZone },
    end: {dateTime: endTime, timeZone },
    attendees: invitees,
    google_calendar_id: 'primary',
    status: 'pending',
    requester_id: message.user,
    reminder: { userDefault: true }
  }

  new Meeting(meetingRecord).save()

  return postMessage(message.channel, scheduleConfirmationPrompt, meetingAttachment)
  .catch(console.error)
}, API_THROTTLE)

const promptReminder = _.throttle(async (result, message) => {
  const reminderParameters = result.parameters.fields

  const subject = capitalizeString(reminderParameters.subject.stringValue)

  const date = reminderParameters.date.stringValue
  const calendarDate = { date: date.split('T')[0] }
  const formattedDate = getFormattedDate(date)

  const scheduleConfirmationPrompt = `Scheduling: ${subject} on ${ formattedDate }`

  const reminderRecord = {
    summary: subject,
    day: calendarDate,
    google_calendar_id: 'primary',
    requester_id: message.user,
  }

  new Task(reminderRecord).save()

  return postMessage(message.channel, scheduleConfirmationPrompt, reminderAttachment)
  .catch(console.error)
}, API_THROTTLE)


module.exports = {
  confirmMeeting,
  confirmReminder,
  displayWeather,
  handleUnexpectedEvent,
  promptMeeting,
  promptReminder,
}
