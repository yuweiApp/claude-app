import type { Attachment } from "../shared/types.js";
import type { SshHost } from "./host.js";
import { nativePath } from "./location.js";
import { mkdirp } from "./remote-ops.js";

/**
 * 远程会话发消息时，非图片的附件传到远端的 ~/.claude-app/workspace/.attachments/<id>/<文件名>，模型在远端用 Read 读。
 * 返回附件 id → 远端路径（远端系统的写法，给模型看的）；同一个附件已经传过（大小一样）就不再传
 */
export async function uploadAttachments(host: SshHost, attachments: Attachment[]): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  if (!attachments.length) return paths;
  await host.ensureReady();
  const sftp = await host.sftp();
  for (const a of attachments) {
    const dir = `${host.env!.attachments}/${a.id}`;
    const target = `${dir}/${a.name}`;
    const size = await new Promise<number | null>((resolve) => sftp.stat(target, (err, s) => resolve(err ? null : s.size)));
    if (size !== a.size) {
      await mkdirp(host, dir).catch((err: Error) => {
        throw new Error(`远端建不了附件目录：${err.message}`);
      });
      await new Promise<void>((resolve, reject) => sftp.fastPut(a.path, target, (err) => (err ? reject(new Error(`附件「${a.name}」传到远端失败：${err.message}`)) : resolve())));
    }
    paths.set(a.id, nativePath(host.windows, target));
  }
  return paths;
}
