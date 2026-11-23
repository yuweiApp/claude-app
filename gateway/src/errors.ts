/**
 * 带 HTTP 状态码的错误：接口返回这个状态码和 { error: message }（app.ts 的错误处理按 statusCode，Fastify 也认这个字段）。
 * 设置填错、文件不存在、远程主机连不上这类要告诉网页原因的，各模块直接抛这几个
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message);
  }
}

/** 现在的状态做不了（这一轮还在进行、消息已经交给模型了等） */
export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

/** 同时运行的会话到上限 */
export class BusyError extends HttpError {
  constructor(message: string) {
    super(429, message);
  }
}
