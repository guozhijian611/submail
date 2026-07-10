const INVISIBLE_HOST_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/gu;

export function normalizeMailboxHost(value: string): string {
  return value.replace(INVISIBLE_HOST_CHARACTERS, "").trim();
}
