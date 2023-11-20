declare module '@sagi.io/workers-jwt' {
  export async function getToken(args: {
    privateKeyPEM: string
    payload: any
    alg?: string
    cryptoImpl?: Crypto | null
    headerAdditions?: { [key: string]: string }
  }): Promise<string>

  export async function getTokenFromGCPServiceAccount(args: {
    serviceAccountJSON: any
    aud: string
    alg?: string
    cryptoImpl?: Crypto | null
    expiredAfter?: number
    headerAdditions?: { [key: string]: string }
    payloadAdditions?: { [key: string]: any }
  }): Promise<string>
}
