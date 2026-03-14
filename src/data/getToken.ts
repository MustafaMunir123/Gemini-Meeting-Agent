import 'server-only'
import { KJUR } from 'jsrsasign'

export async function getData(sessionName: string): Promise<string> {
  return generateSignature(sessionName, 1)
}

function generateSignature(sessionName: string, role: number): string {
  const sdkKey = process.env['ZOOM_SDK_KEY']
  const sdkSecret = process.env['ZOOM_SDK_SECRET']
  if (!sdkKey || !sdkSecret) {
    throw new Error('Missing ZOOM_SDK_KEY or ZOOM_SDK_SECRET')
  }
  const iat = Math.round(Date.now() / 1000) - 30
  const exp = iat + 60 * 60 * 2
  const oHeader = { alg: 'HS256', typ: 'JWT' }
  const oPayload = {
    app_key: sdkKey,
    tpc: sessionName,
    role_type: role,
    version: 1,
    iat,
    exp,
  }
  const sHeader = JSON.stringify(oHeader)
  const sPayload = JSON.stringify(oPayload)
  return KJUR.jws.JWS.sign('HS256', sHeader, sPayload, sdkSecret)
}
