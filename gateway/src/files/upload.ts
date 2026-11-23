import { randomBytes } from "node:crypto";
import { BadRequestError } from "../errors.js";
import { forgetProjectFiles } from "./project-list.js";
import type { InProject } from "./project-path.js";

/** 上传的位置：要是项目里已经有的文件夹 */
export async function uploadDir({ fs, abs }: InProject): Promise<void> {
  const info = await fs.stat(abs).catch(() => null);
  if (!info?.isDirectory) throw new BadRequestError(info ? "上传的位置不是文件夹" : "上传的位置不存在");
}

/**
 * 上传一个文件到 dir（uploadDir 查过的文件夹）：已经有同名文件时报错，overwrite 才覆盖；同名的是文件夹不行。
 * write 先写进同一个文件夹里的临时文件，写完再改成原名；中途失败、取消只删临时文件，原来的同名文件还在
 */
export async function uploadInto(dir: InProject, name: string, overwrite: boolean, write: (tmp: string) => Promise<void>): Promise<void> {
  const { fs, p } = dir;
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name) || (p.sep === "\\" && name.includes(":"))) throw new BadRequestError(`文件名不能用：${name}`);
  const abs = p.join(dir.abs, name);
  const conflict = async () => {
    const old = await fs.stat(abs).catch(() => null);
    if (old?.isDirectory) throw new BadRequestError(`已经有同名的文件夹：${name}`);
    if (old && !overwrite) throw new BadRequestError(`已经有同名的文件：${name}`);
    return old !== null;
  };
  await conflict();
  const tmp = p.join(dir.abs, `.${name}.upload-${randomBytes(4).toString("hex")}`);
  try {
    await write(tmp);
    // 传的时候别处可能新建了同名的，再查一次；SFTP 的改名不能覆盖已有的文件，覆盖时先删掉原来的
    if (await conflict()) await fs.rm(abs);
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp).catch(() => undefined);
    throw err;
  } finally {
    forgetProjectFiles(dir.key);
  }
}
