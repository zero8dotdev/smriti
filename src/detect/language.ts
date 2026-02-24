/**
 * detect/language.ts - Project language and framework detection
 *
 * Auto-detects programming language and framework based on filesystem markers.
 * Used to select appropriate rule sets for classification.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// Types
// =============================================================================

export type DetectionResult = {
  language: string | null; // typescript, python, rust, go, javascript, etc.
  framework: string | null; // nextjs, fastapi, axum, etc.
  languageVersion: string | null; // e.g. "4.9.5", "3.10"
  confidence: number; // 0-1, higher = more confident
  markers: string[]; // Files/dirs that led to detection
};

// =============================================================================
// Detection Heuristics
// =============================================================================

const LANGUAGE_MARKERS: Record<
  string,
  {
    files?: string[];
    dirs?: string[];
    priority: number; // Higher = checked first
  }
> = {
  typescript: {
    files: ["tsconfig.json", "package.json", ".ts"],
    dirs: ["src", "dist"],
    priority: 100,
  },
  javascript: {
    files: ["package.json", ".js", ".jsx"],
    dirs: ["node_modules", "dist"],
    priority: 90,
  },
  python: {
    files: ["pyproject.toml", "requirements.txt", "setup.py", ".py"],
    dirs: ["venv", ".venv", "site-packages"],
    priority: 95,
  },
  rust: {
    files: ["Cargo.toml", "Cargo.lock"],
    dirs: ["target"],
    priority: 110,
  },
  go: {
    files: ["go.mod", "go.sum", ".go"],
    dirs: ["vendor"],
    priority: 100,
  },
};

const FRAMEWORK_MARKERS: Record<
  string,
  {
    language: string;
    files?: string[];
    packagePatterns?: string[]; // Patterns to check in package.json/requirements.txt
    priority: number;
  }
> = {
  nextjs: {
    language: "typescript",
    files: ["next.config.js"],
    packagePatterns: ["next", "react"],
    priority: 100,
  },
  fastapi: {
    language: "python",
    packagePatterns: ["fastapi"],
    priority: 100,
  },
  django: {
    language: "python",
    packagePatterns: ["django"],
    priority: 100,
  },
  axum: {
    language: "rust",
    packagePatterns: ["axum"],
    priority: 100,
  },
  actix: {
    language: "rust",
    packagePatterns: ["actix-web"],
    priority: 100,
  },
};

// =============================================================================
// Detection Logic
// =============================================================================

/**
 * Detect project language and framework.
 */
export async function detectProject(projectPath: string): Promise<DetectionResult> {
  const result: DetectionResult = {
    language: null,
    framework: null,
    languageVersion: null,
    confidence: 0,
    markers: [],
  };

  // Check for file existence
  const hasFile = (name: string): boolean => {
    try {
      return existsSync(join(projectPath, name));
    } catch {
      return false;
    }
  };

  const hasDir = (name: string): boolean => {
    try {
      const p = join(projectPath, name);
      return existsSync(p) && readdirSync(p).length > 0;
    } catch {
      return false;
    }
  };

  const readFile = (name: string): string | null => {
    try {
      const content = readFileSync(join(projectPath, name), "utf-8");
      return content ? content.toString() : null;
    } catch {
      return null;
    }
  };

  // Detect language
  const sortedLanguages = Object.entries(LANGUAGE_MARKERS).sort(
    (a, b) => b[1].priority - a[1].priority
  );

  for (const [lang, markers] of sortedLanguages) {
    let matchCount = 0;
    const detectedMarkers: string[] = [];

    // Check files
    if (markers.files) {
      for (const file of markers.files) {
        if (file.startsWith(".")) {
          // It's a file extension, check if any file has it
          try {
            const files = readdirSync(projectPath);
            const match = files.some((f) => f.endsWith(file));
            if (match) {
              matchCount++;
              detectedMarkers.push(`${file} file(s)`);
            }
          } catch {
            // ignore
          }
        } else if (hasFile(file)) {
          matchCount++;
          detectedMarkers.push(file);
        }
      }
    }

    // Check directories
    if (markers.dirs) {
      for (const dir of markers.dirs) {
        if (hasDir(dir)) {
          matchCount++;
          detectedMarkers.push(`${dir}/`);
        }
      }
    }

    if (matchCount > 0) {
      result.language = lang;
      result.markers = detectedMarkers;
      const totalMarkers = (markers.files?.length || 0) + (markers.dirs?.length || 0);
      result.confidence = Math.min(matchCount / Math.max(totalMarkers, 1), 1);
      break;
    }
  }

  // If no language detected, return null result
  if (!result.language) {
    return result;
  }

  // Detect framework
  const packageJson = readFile("package.json");
  const requirementsTxt = readFile("requirements.txt");
  const cargoToml = readFile("Cargo.toml");

  const sortedFrameworks = Object.entries(FRAMEWORK_MARKERS)
    .filter(([, fw]) => fw.language === result.language)
    .sort((a, b) => b[1].priority - a[1].priority);

  for (const [fw, markers] of sortedFrameworks) {
    let matched = false;
    const frameworkMarkers: string[] = [];

    // Check explicit files
    if (markers.files) {
      for (const file of markers.files) {
        if (hasFile(file)) {
          matched = true;
          frameworkMarkers.push(file);
        }
      }
    }

    // Check package patterns
    if (!matched && markers.packagePatterns) {
      let content = "";
      if (result.language === "typescript" || result.language === "javascript") {
        content = packageJson || "";
      } else if (result.language === "python") {
        content = requirementsTxt || "";
      } else if (result.language === "rust") {
        content = cargoToml || "";
      }

      for (const pattern of markers.packagePatterns) {
        if (content && content.includes(pattern)) {
          matched = true;
          frameworkMarkers.push(`dependency: ${pattern}`);
        }
      }
    }

    if (matched) {
      result.framework = fw;
      result.markers.push(...frameworkMarkers);
      break;
    }
  }

  return result;
}

/**
 * Detect language version from manifest files.
 */
export async function detectLanguageVersion(projectPath: string, language: string): Promise<string | null> {
  const readFile = (name: string): string | null => {
    try {
      const content = readFileSync(join(projectPath, name), "utf-8");
      return content ? content.toString() : null;
    } catch {
      return null;
    }
  };

  if (language === "typescript" || language === "javascript") {
    const packageJson = readFile("package.json");
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        return pkg.engines?.node || pkg.dependencies?.typescript || null;
      } catch {
        return null;
      }
    }
  } else if (language === "python") {
    const pyproject = readFile("pyproject.toml");
    if (pyproject) {
      // Parse TOML for python version
      const match = pyproject.match(/python\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  } else if (language === "rust") {
    const cargoToml = readFile("Cargo.toml");
    if (cargoToml) {
      // Parse TOML for rust version
      const match = cargoToml.match(/rust-version\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  } else if (language === "go") {
    const goMod = readFile("go.mod");
    if (goMod) {
      // Parse go.mod for Go version
      const match = goMod.match(/^go\s+(\d+\.\d+)/m);
      if (match) return match[1];
    }
  }

  return null;
}
