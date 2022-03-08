import * as base64 from 'https://deno.land/x/base64@v0.2.1/mod.ts'
import {
    readerFromStreamReader,
    readAll,
} from 'https://deno.land/std@0.122.0/streams/mod.ts'

export interface HeadersObj {
    [name: string]: string
}

export interface RequestEvent {
    readonly request: Request
    respondWith(r: Response | Promise<Response>): Promise<void>
}

export interface VercelRequestPayload {
    method: string
    path: string
    headers: HeadersObj
    body: string
}

export interface VercelResponsePayload {
    statusCode: number
    headers: HeadersObj
    encoding: 'base64'
    body: string
}

export type StdHandler = (req: Request) => Promise<Response | void>
export type Handler = StdHandler

const RUNTIME_PATH = '2018-06-01/runtime'

const { _HANDLER, ENTRYPOINT, AWS_LAMBDA_RUNTIME_API } = Deno.env.toObject()

async function processEvents(): Promise<void> {
    let handler: Handler | null = null

    while (true) {
        const { event, awsRequestId } = await nextInvocation()
        let result: VercelResponsePayload

        try {
            if (!handler) {
                const mod = await import(`./${_HANDLER}`)
                handler = mod.default
                if (typeof handler !== 'function') {
                    throw new Error('Failed to load handler function')
                }
            }

            const data: VercelRequestPayload = JSON.parse(event.body)
            const base = `${data.headers['x-forwarded-proto']}://${data.headers['x-forwarded-host']}`
            const url = new URL(data.path, base)
            const req = new Request(url.href, {
                headers: new Headers(data.headers),
                method: data.method,
                body: base64.toUint8Array(data.body || ''),
            })

            let res = await handler(req)
            if (!(res instanceof Response)) {
                res = new Response()
            }

            let body = new Uint8Array()
            if (res.body) {
                const reader = readerFromStreamReader(res.body.getReader())
                body = await readAll(reader)
            }

            result = {
                statusCode: res.status,
                headers: Object.fromEntries(res.headers),
                encoding: 'base64',
                body: base64.fromUint8Array(body),
            }
        } catch (e) {
            console.error('Invoke Error:', e)
            await invokeError(e, awsRequestId)
            continue
        }

        await invokeResponse(result, awsRequestId)
    }
}

async function nextInvocation() {
    const res = await request('invocation/next')

    if (res.status !== 200) {
        throw new Error(
            `Unexpected "/invocation/next" response: ${JSON.stringify(res)}`
        )
    }

    const traceId = res.headers.get('lambda-runtime-trace-id')
    if (typeof traceId === 'string') {
        Deno.env.set('_X_AMZN_TRACE_ID', traceId)
    } else {
        Deno.env.delete('_X_AMZN_TRACE_ID')
    }

    const awsRequestId = res.headers.get('lambda-runtime-aws-request-id')
    if (typeof awsRequestId !== 'string') {
        throw new Error(
            'Did not receive "lambda-runtime-aws-request-id" header'
        )
    }

    const event = JSON.parse(res.body)
    return { event, awsRequestId }
}

async function invokeResponse(
    result: VercelResponsePayload,
    awsRequestId: string
) {
    const res = await request(`invocation/${awsRequestId}/response`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(result),
    })
    if (res.status !== 202) {
        throw new Error(
            `Unexpected "/invocation/response" response: ${JSON.stringify(res)}`
        )
    }
}

async function invokeError(err: Error, awsRequestId: string) {
    return postError(`invocation/${awsRequestId}/error`, err)
}

async function postError(path: string, err: Error): Promise<void> {
    const lambdaErr = toLambdaErr(err)
    const res = await request(path, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Lambda-Runtime-Function-Error-Type': 'Unhandled',
        },
        body: JSON.stringify(lambdaErr),
    })
    if (res.status !== 202) {
        throw new Error(`Unexpected "${path}" response: ${JSON.stringify(res)}`)
    }
}

async function request(path: string, options?: RequestInit) {
    const url = `http://${AWS_LAMBDA_RUNTIME_API}/${RUNTIME_PATH}/${path}`
    const res = await fetch(url, options)
    const body = await res.text()
    return {
        status: res.status,
        headers: res.headers,
        body,
    }
}

function toLambdaErr({ name, message, stack }: Error) {
    return {
        errorType: name,
        errorMessage: message,
        stackTrace: (stack || '').split('\n').slice(1),
    }
}

if (_HANDLER) {
    // Runtime - execute the runtime loop
    processEvents().catch((err) => {
        console.error(err)
        Deno.exit(1)
    })
} else {
    // Build - import the entrypoint so that it gets cached
    await import(`./${ENTRYPOINT}`)
}
