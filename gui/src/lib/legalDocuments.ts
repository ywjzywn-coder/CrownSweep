export const legalDocuments = {
  gpl: { title: "GPLv3", load: () => import("../../LICENSE?raw").then(module => module.default) },
  notices: { title: "第三方声明", load: () => import("../../THIRD_PARTY_NOTICES.md?raw").then(module => module.default) },
  dependencies: { title: "依赖许可证", load: () => import("../../licenses/THIRD_PARTY_LICENSES.txt?raw").then(module => module.default) },
};
export type LegalDocumentKey = keyof typeof legalDocuments;
