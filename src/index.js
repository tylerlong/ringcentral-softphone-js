import uuid from 'uuid/v4'
import WebSocket from 'isomorphic-ws'
import EventEmitter from 'events'
import { RTCSessionDescription, RTCPeerConnection } from 'isomorphic-webrtc'

import RequestSipMessage from './sip-message/outbound/request-sip-message'
import InboundSipMessage from './sip-message/inbound/inbound-sip-message'
import ResponseSipMessage from './sip-message/outbound/response-sip-message'
import { generateAuthorization, branch } from './utils'

class Softphone extends EventEmitter {
  constructor (rc) {
    super()
    this.rc = rc
    this.fakeDomain = uuid() + '.invalid'
    this.fakeEmail = uuid() + '@' + this.fakeDomain
    this.fromTag = uuid()
    this.callerId = uuid()
  }

  async handleSipMessage (inboundSipMessage) {
    if (inboundSipMessage.subject.startsWith('INVITE sip:')) { // invite
      await this.response(inboundSipMessage, 180, {
        Contact: `<sip:${this.fakeDomain};transport=ws>`
      })
      this.emit('INVITE', inboundSipMessage)
    } else if (inboundSipMessage.subject.startsWith('BYE ')) { // bye
      this.emit('BYE', inboundSipMessage)
    } else if (inboundSipMessage.subject.startsWith('MESSAGE ') && inboundSipMessage.body.includes(' Cmd="7"')) { // take over
      await this.response(inboundSipMessage, 200)
    }
  }

  async send (sipMessage) {
    return new Promise((resolve, reject) => {
      if (sipMessage.subject.startsWith('SIP/2.0 ')) { // response message, no waiting for response from server side
        this.ws.send(sipMessage.toString())
        resolve(undefined)
        return
      }
      const responseHandler = inboundSipMessage => {
        if (inboundSipMessage.headers.CSeq !== sipMessage.headers.CSeq) {
          return // message not for this send
        }
        if (inboundSipMessage.subject === 'SIP/2.0 100 Trying') {
          return // ignore
        }
        this.off('sipMessage', responseHandler)
        if (inboundSipMessage.subject.startsWith('SIP/2.0 5') || inboundSipMessage.subject.startsWith('SIP/2.0 6')) {
          reject(inboundSipMessage)
          return
        }
        resolve(inboundSipMessage)
      }
      this.on('sipMessage', responseHandler)
      this.ws.send(sipMessage.toString())
    })
  }

  async response (inboundSipMessage, responseCode, headers = {}, body = '') {
    await this.send(new ResponseSipMessage(inboundSipMessage, responseCode, headers, body))
  }

  async register () {
    const r = await this.rc.post('/restapi/v1.0/client-info/sip-provision', {
      sipInfo: [{ transport: 'WSS' }]
    })
    const json = await r.json()
    this.device = json.device
    this.sipInfo = json.sipInfo[0]
    this.ws = new WebSocket('wss://' + this.sipInfo.outboundProxy, 'sip', { rejectUnauthorized: false })
    /* this is for debugging - start */
    this.ws.addEventListener('message', e => {
      console.log('\n***** WebSocket Got - start *****')
      console.log(e.data)
      console.log('***** WebSocket Got - end *****\n')
    })
    const send = this.ws.send.bind(this.ws)
    this.ws.send = (...args) => {
      console.log('\n***** WebSocket Send - start *****')
      console.log(...args)
      console.log('***** WebSocket Send - end *****\n')
      send(...args)
    }
    /* this is for debugging - end */
    this.ws.addEventListener('message', e => {
      const sipMessage = InboundSipMessage.fromString(e.data)
      this.emit('sipMessage', sipMessage)
      this.handleSipMessage(sipMessage)
    })
    const openHandler = async e => {
      this.ws.removeEventListener('open', openHandler)
      const requestSipMessage = new RequestSipMessage(`REGISTER sip:${this.sipInfo.domain} SIP/2.0`, {
        'Call-ID': this.callerId,
        Contact: `<sip:${this.fakeEmail};transport=ws>;expires=600`,
        From: `<sip:${this.sipInfo.username}@${this.sipInfo.domain}>;tag=${this.fromTag}`,
        To: `<sip:${this.sipInfo.username}@${this.sipInfo.domain}>`,
        Via: `SIP/2.0/WSS ${this.fakeDomain};branch=${branch()}`
      })
      let inboundSipMessage = await this.send(requestSipMessage)
      const wwwAuth = inboundSipMessage.headers['Www-Authenticate']
      if (wwwAuth && wwwAuth.includes(', nonce="')) { // authorization required
        const nonce = wwwAuth.match(/, nonce="(.+?)"/)[1]
        requestSipMessage.headers.Authorization = generateAuthorization(this.sipInfo, 'REGISTER', nonce)
        inboundSipMessage = await this.send(requestSipMessage)
      }
    }
    this.ws.addEventListener('open', openHandler)
  }

  async answer (inviteSipMessage, inputAudioStream = undefined) {
    const sdp = inviteSipMessage.body
    const remoteRtcSd = new RTCSessionDescription({ type: 'offer', sdp })
    const peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:74.125.194.127:19302' }] })
    peerConnection.addEventListener('track', e => {
      this.emit('track', e)
    })
    peerConnection.setRemoteDescription(remoteRtcSd)
    if (inputAudioStream) {
      const track = inputAudioStream.getAudioTracks()[0]
      peerConnection.addTrack(track, inputAudioStream)
    }
    const localRtcSd = await peerConnection.createAnswer()
    peerConnection.setLocalDescription(localRtcSd)
    await this.response(inviteSipMessage, 200, {
      Contact: `<sip:${this.fakeEmail};transport=ws>`,
      'Content-Type': 'application/sdp'
    }, localRtcSd.sdp)
  }

  async toVoicemail () {
    // const requestSipMessage = new RequestSipMessage('')
  }
}

export default Softphone
