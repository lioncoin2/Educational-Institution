import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request as the stub received it. */
export interface StubRequest {
  readonly method: string;
  /** The path and query, as sent. */
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * What the stub answers: a status with a body of a content type; or nothing
 * at all — the connection stays open, for a client's timeout; or a reset —
 * the socket is destroyed as soon as the request has arrived.
 */
export type StubAnswer =
  | { readonly status: number; readonly body?: string; readonly contentType?: string }
  | 'no_answer'
  | 'reset';

export interface StubHttpServer {
  /** e.g. http://127.0.0.1:41234 */
  readonly url: string;
  readonly port: number;
  /** Every request received, oldest first. */
  readonly requests: readonly StubRequest[];
  /** How every request is answered from now on. */
  answer(answer: StubAnswer | ((request: StubRequest) => StubAnswer)): void;
  close(): Promise<void>;
}

/**
 * A plain HTTP server on the loopback interface that answers what a test
 * tells it to — the stand-in for whatever a misconfigured URL reaches: a
 * reverse proxy's error page, another service, a server that never answers.
 * Answers 200 with an empty JSON object until told otherwise.
 */
export async function startStubHttpServer(): Promise<StubHttpServer> {
  const requests: StubRequest[] = [];
  let answerFor: (request: StubRequest) => StubAnswer = () => ({
    status: 200,
    body: '{}',
    contentType: 'application/json',
  });

  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request: StubRequest = {
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      const answer = answerFor(request);
      if (answer === 'no_answer') return;
      if (answer === 'reset') {
        incoming.socket.destroy();
        return;
      }
      response.writeHead(answer.status, {
        'content-type': answer.contentType ?? 'text/plain; charset=utf-8',
      });
      response.end(answer.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    answer(answer) {
      answerFor = typeof answer === 'function' ? answer : () => answer;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

/** A loopback port nothing listens on: taken, then released. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
