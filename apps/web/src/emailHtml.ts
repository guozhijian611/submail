import DOMPurify from "dompurify";

type PreparedEmailHtml = {
  srcDoc: string;
  externalResourceCount: number;
};

const externalUrlPattern = /^(?:https?:)?\/\//i;
const cssExternalUrlPattern = /url\(\s*(["']?)(?:(?:https?:)?\/\/)[^)]*\1\s*\)/gi;
const cssImportPattern = /@import\s+(?:url\(\s*)?["']?(?:(?:https?:)?\/\/)[^;]+;?/gi;
const resourceAttributes: Array<[string, string]> = [
  ["img", "src"],
  ["img", "srcset"],
  ["source", "src"],
  ["source", "srcset"],
  ["video", "src"],
  ["video", "poster"],
  ["audio", "src"],
  ["track", "src"],
  ["table", "background"],
  ["td", "background"],
  ["th", "background"]
];
const preparseResourceAttributePattern = /(\s)(src|srcset|poster|background|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const linkTagPattern = /<link\b[^>]*>/gi;

function externalReferences(value: string): number {
  if (!value.trim()) return 0;
  if (externalUrlPattern.test(value.trim())) return 1;
  return value.split(",").filter((candidate) => externalUrlPattern.test(candidate.trim().split(/\s+/u)[0] ?? "")).length;
}

function processCss(css: string, allowExternalResources: boolean): { css: string; count: number } {
  const importMatches = css.match(cssImportPattern)?.length ?? 0;
  const urlMatches = css.match(cssExternalUrlPattern)?.length ?? 0;
  if (allowExternalResources) return { css, count: importMatches + urlMatches };
  return {
    css: css.replace(cssImportPattern, "").replace(cssExternalUrlPattern, "none"),
    count: importMatches + urlMatches
  };
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function serializeAttributes(element: Element): string {
  const attributes = Array.from(element.attributes)
    .map((attribute) => `${attribute.name}="${escapeHtmlAttribute(attribute.value)}"`)
    .join(" ");
  return attributes ? ` ${attributes}` : "";
}

function safeStyleText(value: string): string {
  return value.replace(/<\/style/giu, "<\\/style");
}

function blockExternalResourcesBeforeParsing(rawHtml: string): { html: string; count: number } {
  let count = 0;
  let html = rawHtml.replace(preparseResourceAttributePattern, (full, prefix: string, attribute: string, doubleQuoted?: string, singleQuoted?: string, unquoted?: string) => {
    const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    const references = externalReferences(value);
    if (references === 0) return full;
    count += references;
    return `${prefix}data-submail-blocked-${attribute.toLowerCase()}="${encodeURIComponent(value)}"`;
  });
  html = html.replace(linkTagPattern, (tag) => {
    const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = href?.[1] ?? href?.[2] ?? href?.[3] ?? "";
    const references = externalReferences(value);
    if (references === 0) return tag;
    count += references;
    return "";
  });
  const processedCss = processCss(html, false);
  return { html: processedCss.css, count: count + processedCss.count };
}

export function prepareEmailHtml(rawHtml: string, allowExternalResources: boolean, allowVerticalScroll = false): PreparedEmailHtml {
  const preprocessed = allowExternalResources
    ? { html: rawHtml, count: 0 }
    : blockExternalResourcesBeforeParsing(rawHtml);
  const sanitized = String(DOMPurify.sanitize(preprocessed.html, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "base", "meta", "link"],
    FORBID_ATTR: ["srcdoc"],
    ADD_ATTR: ["target", "rel"]
  }));
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  let externalResourceCount = preprocessed.count;

  for (const element of document.querySelectorAll<HTMLElement>("[data-submail-blocked-src], [data-submail-blocked-srcset], [data-submail-blocked-poster], [data-submail-blocked-background], [data-submail-blocked-data]")) {
    if (element instanceof HTMLImageElement) {
      element.classList.add("submailRemoteImageBlocked");
      element.alt = element.alt ? `${element.alt}（外部图片已阻止）` : "外部图片已阻止";
    }
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith("data-submail-blocked-")) element.removeAttribute(attribute.name);
    }
  }

  for (const [selector, attribute] of resourceAttributes) {
    for (const element of document.querySelectorAll<HTMLElement>(`${selector}[${attribute}]`)) {
      const value = element.getAttribute(attribute) ?? "";
      const count = externalReferences(value);
      if (count === 0) continue;
      externalResourceCount += count;
      if (!allowExternalResources) {
        element.removeAttribute(attribute);
        if (element instanceof HTMLImageElement) {
          element.classList.add("submailRemoteImageBlocked");
          element.alt = element.alt ? `${element.alt}（外部图片已阻止）` : "外部图片已阻止";
        }
      }
    }
  }

  for (const element of document.querySelectorAll<HTMLElement>("[style]")) {
    const processed = processCss(element.getAttribute("style") ?? "", allowExternalResources);
    externalResourceCount += processed.count;
    element.setAttribute("style", processed.css);
  }
  const emailStyles: string[] = [];
  for (const style of document.querySelectorAll("style")) {
    const processed = processCss(style.textContent ?? "", allowExternalResources);
    externalResourceCount += processed.count;
    emailStyles.push(processed.css);
    style.remove();
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer nofollow";
  }

  const contentSecurityPolicy = allowExternalResources
    ? "default-src 'none'; img-src data: http: https:; media-src data: http: https:; font-src data: http: https:; style-src 'unsafe-inline' http: https:"
    : "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'";
  const baseStyles = `
    :root { color-scheme: light; }
    html, body { margin: 0; padding: 0; background: #fff; color: #2f3c39; }
    body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 15px; line-height: 1.7; overflow-wrap: anywhere; }
    img { max-width: 100% !important; height: auto !important; }
    table { max-width: 100% !important; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    a { color: #126b62; }
    blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid #dce6e3; color: #596763; }
    .submailRemoteImageBlocked { display: inline-block; min-width: 140px; min-height: 34px; padding: 6px; color: #71807c; background: #f4f7f6; border: 1px dashed #cdd9d6; }
  `;
  const measurementStyles = `
    html, body { min-height: 0 !important; height: auto !important; }
    html { overflow-y: ${allowVerticalScroll ? "auto" : "hidden"} !important; }
    body { overflow-y: visible !important; }
  `;
  const serializedEmailStyles = emailStyles
    .filter((style) => style.trim())
    .map((style) => `<style>${safeStyleText(style)}</style>`)
    .join("");
  for (const element of [document.documentElement, document.body]) {
    element.style.setProperty("min-height", "0", "important");
    element.style.setProperty("height", "auto", "important");
  }
  document.documentElement.style.setProperty("overflow-y", allowVerticalScroll ? "auto" : "hidden", "important");
  document.body.style.setProperty("overflow-y", "visible", "important");
  const htmlAttributes = serializeAttributes(document.documentElement);
  const bodyAttributes = serializeAttributes(document.body);
  return {
    externalResourceCount,
    srcDoc: `<!doctype html><html${htmlAttributes}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"><meta name="referrer" content="no-referrer"><style>${baseStyles}</style>${serializedEmailStyles}<style>${measurementStyles}</style></head><body${bodyAttributes}>${document.body.innerHTML}</body></html>`
  };
}
