import type { FastifyInstance } from "fastify";
import { saveUpload } from "../../agent/attachments.js";
import type { Attachment } from "../../shared/types.js";

/** POST /uploads：multipart，可以一次传多个文件，存到工作目录的 .attachments 下 */
export function uploadRoutes(app: FastifyInstance): void {
  app.post("/uploads", async (req) => {
    const attachments: Attachment[] = [];
    for await (const part of req.files()) {
      attachments.push(await saveUpload(part.filename, part.file));
    }
    return { attachments };
  });
}
