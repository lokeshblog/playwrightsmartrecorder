import { z } from "zod";

export const defaultConfig = {
  maxAncestorDepth: 5,
  semanticBoundaries: [
    "form",
    "section",
    "article",
    "nav",
    "main",
    "dialog",
    "table",
    "ul",
    "ol",
  ],
  preferredAttributes: ["data-testid", "data-test", "data-cy", "data-qa"],
  applicationAttributes: ["data-component", "data-field", "data-action"],
  avoidAttributes: ["style"],
  generatedValuePatterns: [
    "^css-[a-z0-9]+$",
    "^sc-[A-Za-z0-9]+$",
    "^ember\\d+$",
    "^(react|vue|ng)[-_]?\\d+$",
    "^react-select-\\d+-",
    "^mui-\\d+$",
    "^jss\\d+$",
    "^makeStyles-[A-Za-z0-9]+-\\d+$",
    "^:r[0-9a-z]+:$",
    "^radix-[A-Za-z0-9_-]+$",
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    "^[a-f0-9]{10,}$",
    "^\\d{4,}$",
  ],
  minimumLocatorScore: 70,
  requireUniqueLocator: true,
  nearbyElementLimit: 8,
  maxContainerHtmlLength: 50_000,
} as const;

export const smartConfigSchema = z.object({
  maxAncestorDepth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(defaultConfig.maxAncestorDepth),
  semanticBoundaries: z
    .array(z.string())
    .default([...defaultConfig.semanticBoundaries]),
  preferredAttributes: z
    .array(z.string())
    .default([...defaultConfig.preferredAttributes]),
  applicationAttributes: z
    .array(z.string())
    .default([...defaultConfig.applicationAttributes]),
  avoidAttributes: z
    .array(z.string())
    .default([...defaultConfig.avoidAttributes]),
  generatedValuePatterns: z
    .array(z.string())
    .default([...defaultConfig.generatedValuePatterns]),
  minimumLocatorScore: z
    .number()
    .min(0)
    .max(150)
    .default(defaultConfig.minimumLocatorScore),
  requireUniqueLocator: z.boolean().default(defaultConfig.requireUniqueLocator),
  nearbyElementLimit: z
    .number()
    .int()
    .min(0)
    .max(30)
    .default(defaultConfig.nearbyElementLimit),
  maxContainerHtmlLength: z
    .number()
    .int()
    .min(1_000)
    .max(500_000)
    .default(defaultConfig.maxContainerHtmlLength),
});

const disabledStateSchema = z.object({
  hasDisabledAttribute: z.boolean(),
  ariaDisabled: z.literal("true").nullable(),
  nativeDisabled: z.boolean(),
  blueprintDisabledClass: z.boolean(),
  tabIndex: z.number().int().nullable(),
  tagName: z.string(),
  role: z.string().nullable(),
});

const locatorHintSchema = z.object({
  testId: z.string().optional(),
  nameHint: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  tagName: z.string().optional(),
  scope: z.string().optional(),
  expression: z.string().optional(),
});

const elementSchema = z.object({
  tag: z.string(),
  childElementCount: z.number().int().min(0).optional(),
  text: z.string().optional(),
  accessibleName: z.string().optional(),
  role: z.string().optional(),
  html: z.string().optional(),
  attributes: z.record(z.string(), z.string()),
  disabledState: disabledStateSchema.optional(),
});

const candidateSchema = z.object({
  locator: z.string(),
  kind: z.enum([
    "testId",
    "applicationAttribute",
    "role",
    "label",
    "id",
    "placeholder",
    "text",
    "css",
    "xpath",
    "positional",
    "scoped",
  ]),
  score: z.number(),
  matchCount: z.number().int().min(0),
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(z.string()),
  penalties: z.array(z.string()),
  generated: z.boolean().optional(),
  resolvesToTarget: z.boolean().optional(),
});

export const locatorContextSchema = z.object({
  version: z.literal("1.0"),
  capturedAt: z.string(),
  url: z.string(),
  pageHeading: z.string().optional(),
  codegenLocator: z.object({
    type: z.string(),
    value: z.string(),
    name: z.string().optional(),
    expression: z.string(),
  }),
  target: elementSchema,
  ancestors: z.array(
    elementSchema.extend({ depth: z.number(), boundary: z.boolean() }),
  ),
  siblings: z.array(
    elementSchema.extend({
      relation: z.enum(["previous", "next", "relevant"]),
    }),
  ),
  nearby: z.array(
    elementSchema.extend({
      relationship: z.enum(["label", "heading", "control", "semantic"]),
    }),
  ),
  matchingElements: z.object({ codegenLocatorCount: z.number().int().min(0) }),
  candidates: z.array(candidateSchema),
  recommended: candidateSchema.nullable(),
  alternatives: z.array(candidateSchema),
  rejected: z.array(z.object({ locator: z.string(), reason: z.string() })),
  containerHtml: z.string().optional(),
  containerHtmlTruncated: z.boolean().optional(),
});

export const scenarioContextSchema = z.object({
  version: z.literal("1.0"),
  name: z.string(),
  capturedAt: z.string(),
  startUrl: z.string(),
  endUrl: z.string(),
  steps: z.array(
    z.object({
      index: z.number().int().positive(),
      timestamp: z.string(),
      pageUrl: z.string(),
      urlAfter: z.string().optional(),
      action: z.object({
        type: z.enum([
          "click",
          "doubleClick",
          "hover",
          "fill",
          "selectOption",
          "setInputFiles",
          "check",
          "uncheck",
          "press",
          "navigate",
          "assert",
        ]),
        value: z.string().optional(),
        selectBy: z.enum(["value", "label"]).optional(),
        force: z.boolean().optional(),
        assertion: z
          .object({
            matcher: z.enum([
              "toBeAttached",
              "toBeVisible",
              "toBeHidden",
              "toBeEnabled",
              "toBeDisabled",
              "toBeEditable",
              "toBeEmpty",
              "toBeFocused",
              "toBeChecked",
              "toBeInViewport",
              "toHaveAccessibleDescription",
              "toHaveAccessibleErrorMessage",
              "toHaveAccessibleName",
              "toHaveText",
              "toContainText",
              "toHaveValue",
              "toHaveValues",
              "toHaveAttribute",
              "toHaveClass",
              "toHaveCSS",
              "toHaveId",
              "toHaveJSProperty",
              "toHaveRole",
              "toHaveScreenshot",
              "toHaveCount",
            ]),
            expected: z
              .union([z.string(), z.array(z.string()), z.number(), z.boolean()])
              .optional(),
            attribute: z.string().optional(),
            negated: z.boolean().optional(),
          })
          .optional(),
      }),
      locatorContext: locatorContextSchema.nullable(),
      locator: z.string(),
      code: z.string(),
      confidence: z.enum(["high", "medium", "low", "unresolved"]),
      warning: z.string().optional(),
      suggestions: z.array(z.string()),
      targetSummary: z.string().optional(),
      intent: z.string().optional(),
      productHints: z
        .object({
          navModule: z.string().optional(),
          pageHeading: z.string().optional(),
          feature: z.string().optional(),
        })
        .optional(),
      locatorHint: locatorHintSchema.optional(),
      disabledState: disabledStateSchema.optional(),
      skipInTest: z.boolean().optional(),
      valueKind: z
        .object({
          kind: z.enum(["secret", "unique", "literal"]).optional(),
          unique: z.boolean(),
          createsResource: z.boolean(),
        })
        .optional(),
      expect: z
        .object({
          kind: z.enum(["heading", "toast", "row-visible", "assertion"]),
          matcher: z.enum([
            "toBeAttached",
            "toBeVisible",
            "toBeHidden",
            "toBeEnabled",
            "toBeDisabled",
            "toBeEditable",
            "toBeEmpty",
            "toBeFocused",
            "toBeChecked",
            "toBeInViewport",
            "toHaveAccessibleDescription",
            "toHaveAccessibleErrorMessage",
            "toHaveAccessibleName",
            "toHaveText",
            "toContainText",
            "toHaveValue",
            "toHaveValues",
            "toHaveAttribute",
            "toHaveClass",
            "toHaveCSS",
            "toHaveId",
            "toHaveJSProperty",
            "toHaveRole",
            "toHaveScreenshot",
            "toHaveCount",
            "toBeRestricted",
          ]),
          value: z
            .union([z.string(), z.array(z.string()), z.number(), z.boolean()])
            .optional(),
          name: z.string().optional(),
          signals: z
            .array(
              z.enum([
                "disabled-attribute",
                "aria-disabled",
                "native-disabled",
                "bp3-disabled",
              ]),
            )
            .optional(),
          group: z
            .object({
              notAuthorized: z.string().optional(),
              missingPermission: z.string().optional(),
              permissionInScope: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
      testCaseId: z.string(),
      businessStep: z.string(),
    }),
  ),
  testCases: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      jiraId: z.string().optional(),
      zephyrId: z.string().optional(),
      stepIndexes: z.array(z.number().int().positive()),
    }),
  ),
  generatedCode: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const scenarioIntentSchema = z.object({
  version: z.literal("1.0"),
  name: z.string(),
  startUrl: z.string(),
  endUrl: z.string(),
  productHints: z.object({
    navModules: z.array(z.string()),
    pageHeadings: z.array(z.string()),
    features: z.array(z.string()),
  }),
  testCases: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      jiraId: z.string().optional(),
      zephyrId: z.string().optional(),
      steps: z.array(
        z.object({
          index: z.number().int().positive(),
          startUrl: z.string(),
          urlAfter: z.string(),
          intent: z.string(),
          action: z.enum([
            "click",
            "doubleClick",
            "hover",
            "fill",
            "selectOption",
            "setInputFiles",
            "check",
            "uncheck",
            "press",
            "navigate",
            "assert",
          ]),
          value: z.string().optional(),
          locatorHint: locatorHintSchema.optional(),
          disabledState: disabledStateSchema.optional(),
          productHints: z.record(z.string(), z.string()).optional(),
          skipInTest: z.boolean(),
          valueKind: z
            .object({
              kind: z.enum(["secret", "unique", "literal"]).optional(),
              unique: z.boolean(),
              createsResource: z.boolean(),
            })
            .optional(),
          expect: z
            .object({
              kind: z.enum(["heading", "toast", "row-visible", "assertion"]),
              matcher: z.string(),
              value: z
                .union([
                  z.string(),
                  z.array(z.string()),
                  z.number(),
                  z.boolean(),
                ])
                .optional(),
              name: z.string().optional(),
              signals: z
                .array(
                  z.enum([
                    "disabled-attribute",
                    "aria-disabled",
                    "native-disabled",
                    "bp3-disabled",
                  ]),
                )
                .optional(),
              group: z
                .object({
                  notAuthorized: z.string().optional(),
                  missingPermission: z.string().optional(),
                  permissionInScope: z.string().optional(),
                })
                .optional(),
            })
            .optional(),
          confidence: z.enum(["high", "medium", "low", "unresolved"]),
          context: z.string().optional(),
        }),
      ),
    }),
  ),
  unresolvedStepIndexes: z.array(z.number().int().positive()),
});

export const replayReportSchema = z.object({
  version: z.literal("1.0"),
  scenarioName: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  status: z.enum(["passed", "failed", "aborted"]),
  startUrl: z.string(),
  results: z.array(
    z.object({
      stepIndex: z.number().int().positive(),
      testCaseId: z.string(),
      status: z.enum(["pending", "running", "passed", "failed", "skipped"]),
      startedAt: z.string().optional(),
      finishedAt: z.string().optional(),
      durationMs: z.number().min(0).optional(),
      attempts: z.number().int().min(0),
      locator: z.string(),
      error: z.string().optional(),
    }),
  ),
  repairedStepIndexes: z.array(z.number().int().positive()),
  skippedStepIndexes: z.array(z.number().int().positive()),
});
