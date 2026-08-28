export const PRODUCT_NAME = "SulatHQ";
export const PRODUCT_MARK = "S";
export const PRODUCT_TAGLINE = "Your mail headquarters";
export const PRODUCT_DESCRIPTION =
  "Self-service custom-domain email. Own the domain, manage the addresses, keep the inbox.";

export function documentTitle(page?: string) {
  return page ? `${page} · ${PRODUCT_NAME}` : `${PRODUCT_NAME} · ${PRODUCT_TAGLINE}`;
}
