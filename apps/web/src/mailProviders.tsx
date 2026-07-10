import type { CSSProperties } from "react";

export type IncomingProtocol = "imap" | "pop3";
export type MailAuthMode = "password" | "app_password";

export type ServerPreset = { host: string; port: number; secure: boolean };
export type MailProvider = {
  id: string;
  name: string;
  mark: string;
  color: string;
  domains: string[];
  imap?: ServerPreset;
  pop3?: ServerPreset;
  smtp: ServerPreset;
  preferredAuth: MailAuthMode;
  passwordAuthSupported?: boolean;
  authHelp: string;
};

export const genericMailProvider: MailProvider = {
  id: "generic",
  name: "其他邮箱",
  mark: "@",
  color: "#60716d",
  domains: [],
  smtp: { host: "", port: 465, secure: true },
  preferredAuth: "app_password",
  authHelp: "如果账号开启了二次验证，请在邮箱服务商后台生成应用专用密码或客户端授权码。POP3/IMAP/SMTP 无法弹出短信或 OTP 验证。"
};

export const mailProviders: MailProvider[] = [
  {
    id: "gmail", name: "Gmail", mark: "M", color: "#d94a3d", domains: ["gmail.com", "googlemail.com"],
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    pop3: { host: "pop.gmail.com", port: 995, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    preferredAuth: "app_password",
    passwordAuthSupported: false,
    authHelp: "Google 账号开启两步验证后，请生成 16 位应用专用密码并填在这里；复制时产生的空格会自动移除。还需在 Gmail 设置中允许对应的 POP 或 IMAP。"
  },
  {
    id: "outlook", name: "Outlook", mark: "O", color: "#1473e6", domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    pop3: { host: "outlook.office365.com", port: 995, secure: true },
    smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
    preferredAuth: "app_password",
    authHelp: "开启两步验证后可填写 Microsoft 应用密码。若公司策略强制 OAuth，当前密码接入方式会被拒绝。"
  },
  {
    id: "qq", name: "QQ 邮箱", mark: "QQ", color: "#1583d8", domains: ["qq.com", "foxmail.com"],
    imap: { host: "imap.qq.com", port: 993, secure: true }, pop3: { host: "pop.qq.com", port: 995, secure: true },
    smtp: { host: "smtp.qq.com", port: 465, secure: true }, preferredAuth: "app_password",
    passwordAuthSupported: false,
    authHelp: "请先在 QQ 邮箱“设置 → 账号与安全”开启 POP3/IMAP/SMTP 服务，然后填写生成的客户端授权码。"
  },
  {
    id: "163", name: "网易 163", mark: "163", color: "#d92f2f", domains: ["163.com", "yeah.net"],
    imap: { host: "imap.163.com", port: 993, secure: true }, pop3: { host: "pop.163.com", port: 995, secure: true },
    smtp: { host: "smtp.163.com", port: 465, secure: true }, preferredAuth: "app_password",
    passwordAuthSupported: false,
    authHelp: "请在网易邮箱设置中开启 IMAP/SMTP 或 POP3/SMTP 服务，并填写客户端授权码。"
  },
  {
    id: "126", name: "网易 126", mark: "126", color: "#d92f2f", domains: ["126.com"],
    imap: { host: "imap.126.com", port: 993, secure: true }, pop3: { host: "pop.126.com", port: 995, secure: true },
    smtp: { host: "smtp.126.com", port: 465, secure: true }, preferredAuth: "app_password",
    passwordAuthSupported: false,
    authHelp: "请在网易邮箱设置中开启 IMAP/SMTP 或 POP3/SMTP 服务，并填写客户端授权码。"
  },
  {
    id: "icloud", name: "iCloud Mail", mark: "☁", color: "#5a91ce", domains: ["icloud.com", "me.com", "mac.com"],
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false }, preferredAuth: "app_password",
    passwordAuthSupported: false,
    authHelp: "iCloud 不支持 POP3。请在 Apple 账户中生成 App 专用密码，并使用 IMAP 接入。"
  },
  {
    id: "yahoo", name: "Yahoo Mail", mark: "Y!", color: "#6f2dbd", domains: ["yahoo.com", "yahoo.com.cn"],
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true }, pop3: { host: "pop.mail.yahoo.com", port: 995, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true }, preferredAuth: "app_password",
    passwordAuthSupported: false,
    authHelp: "请在 Yahoo 账号安全设置中生成第三方应用密码。"
  },
  {
    id: "zoho", name: "Zoho Mail", mark: "Z", color: "#e69b22", domains: ["zoho.com", "zohomail.com"],
    imap: { host: "imap.zoho.com", port: 993, secure: true }, pop3: { host: "pop.zoho.com", port: 995, secure: true },
    smtp: { host: "smtp.zoho.com", port: 465, secure: true }, preferredAuth: "app_password",
    authHelp: "启用多因素认证后，请在 Zoho 安全设置中创建应用专用密码。企业域名的服务器地址可能因数据中心而不同。"
  }
];

export function detectMailProvider(email: string): MailProvider {
  const domain = email.trim().toLowerCase().split("@").at(-1) ?? "";
  return mailProviders.find((provider) => provider.domains.some((item) => domain === item || domain.endsWith(`.${item}`))) ?? genericMailProvider;
}

export function MailProviderIcon({ email, size = 28 }: { email: string; size?: number }) {
  const provider = detectMailProvider(email);
  return <span className={`mailProviderIcon provider-${provider.id}`} style={{ "--provider-color": provider.color, width: size, height: size } as CSSProperties} aria-label={provider.name}>{provider.mark}</span>;
}
