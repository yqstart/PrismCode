export interface GitAuthDialogOptions {
  title?: string;
  /** 远程地址，展示给用户 */
  remoteUrl?: string;
  /** 附加说明（如上次失败原因） */
  message?: string;
  defaultUsername?: string;
}

export interface GitAuthResult {
  username: string;
  password: string;
  remember: boolean;
}

type AuthHandler = (options: GitAuthDialogOptions) => Promise<GitAuthResult | null>;

let handler: AuthHandler | null = null;

/** 由 GitAuthDialog 挂载时注册 */
export function registerGitAuthHandler(next: AuthHandler | null) {
  handler = next;
}

/** WebStorm 风格：弹出远程账号 / 密码（含「记住」） */
export async function promptGitAuth(
  options: GitAuthDialogOptions = {},
): Promise<GitAuthResult | null> {
  if (!handler) {
    console.warn("[prismcode] GitAuthDialog 未挂载");
    return null;
  }
  return handler(options);
}
