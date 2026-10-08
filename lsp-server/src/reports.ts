import { URI } from "vscode-uri";
import { Project } from "./project";

export interface ReportLocation {
  locale: string;
  uri: string;
  line: number;
  character: number;
}

export interface ProjectReport {
  root: string;
  locales: string[];
  totalKeys: number;
  /** False while indexing, or when no source file contains a recognizable call */
  usageAvailable: boolean;
  unusedKeys: Array<{ key: string; locations: ReportLocation[] }>;
  missingTranslations: Array<{ key: string; missingLocales: string[]; location: ReportLocation | null }>;
}

/** Summarize translation health for one project. */
export function buildReport(project: Project): ProjectReport {
  const { store, usage, config } = project;
  const usageAvailable = config.reportUnusedKeys && usage.ready && usage.hasAnyCalls();

  const report: ProjectReport = {
    root: project.root,
    locales: store.allLocales(),
    totalKeys: store.allKeys().length,
    usageAvailable,
    unusedKeys: [],
    missingTranslations: [],
  };

  for (const key of store.allKeys()) {
    const entries = store.getEntries(key)!;
    const locate = (locale: string): ReportLocation | null => {
      const loc = entries.get(locale)?.location;
      return loc
        ? { locale, uri: URI.file(loc.filePath).toString(), line: loc.line, character: loc.character }
        : null;
    };

    if (usageAvailable && !usage.isUsed(key)) {
      report.unusedKeys.push({
        key,
        locations: Array.from(entries.keys())
          .sort()
          .map((l) => locate(l)!),
      });
    }

    const missingLocales = store.allLocales(store.namespaceOf(key)).filter((l) => !entries.has(l));
    if (missingLocales.length > 0) {
      const present = entries.has(config.defaultLocale) ? config.defaultLocale : Array.from(entries.keys())[0];
      report.missingTranslations.push({ key, missingLocales, location: locate(present) });
    }
  }

  return report;
}
