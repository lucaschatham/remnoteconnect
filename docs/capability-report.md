# RemNoteConnect Capability Report

Generated: 2026-07-02T00:55:01.306Z
Run ID: `__codex_probe__-mr2sl4yr`
SDK target: `@remnote/plugin-sdk@0.0.46`
Bridge connected: `true`
Plugin version: `0.2.0`
Accessible Rem count at probe time: `58102`

## Summary

- PASS: 10
- FAIL: 1
- UNSUPPORTED: 2

## Capability Matrix

| Capability | Status | SDK/API Method | Workaround / Notes |
|---|---:|---|---|
| `frontBackCard` | PASS | `rem.setText + rem.setBackText + rem.setEnablePractice + rem.setPracticeDirection` |  |
| `conceptCard` | PASS | `plugin.rem.createTreeWithMarkdown using RemNote concept delimiter ::` |  |
| `descriptorCard` | PASS | `plugin.rem.createTreeWithMarkdown using RemNote descriptor delimiter ;;` |  |
| `clozeCard` | PASS | `richText.applyTextFormatToRange(..., 'cloze') + rem.setEnablePractice` |  |
| `multiLineCard` | PASS | `plugin.rem.createTreeWithMarkdown using RemNote multi-line delimiter >>>` |  |
| `listAnswerCard` | PASS | `plugin.rem.createTreeWithMarkdown using RemNote list-answer delimiter >>1.` |  |
| `imageOcclusion` | UNSUPPORTED | `SDK method introspection` | Use RemNote's native UI for image occlusion or store images/context for user-assisted occlusion until the SDK exposes a scriptable API. |
| `properties` | PASS | `rem.addPowerup + rem.setPowerupProperty + rem.getPowerupPropertyAsRichText` |  |
| `portals` | PASS | `rem.addToPortal` |  |
| `orderedInsertion` | PASS | `rem.setParent(parent, positionAmongstSiblings)` |  |
| `nativeTrashRestore` | UNSUPPORTED | `SDK method introspection` | Continue tombstone-by-move; snapshot restore is copy-only and not true undo. |
| `driftPrimitives` | PASS | `rem.updatedAt + SDK method introspection` |  |
| `mediaDataUriImage` | FAIL | `richText.image(dataUri) + setText + optional toHTML/findAllExternalURLs` |  |

## Detailed Results


```json
[
  {
    "capability": "frontBackCard",
    "status": "PASS",
    "method": "rem.setText + rem.setBackText + rem.setEnablePractice + rem.setPracticeDirection",
    "details": {
      "remId": "XPfdd0rX8ZakeI7JJ",
      "cardCount": 1,
      "cardTypes": [
        "forward"
      ],
      "cards": [
        {
          "id": "ZBj2NFEG2eyq8GQg8",
          "remId": "XPfdd0rX8ZakeI7JJ",
          "type": "forward",
          "createdAt": 1782953683938,
          "nextRepetitionTime": 1782953683938
        }
      ]
    }
  },
  {
    "capability": "conceptCard",
    "status": "PASS",
    "method": "plugin.rem.createTreeWithMarkdown using RemNote concept delimiter ::",
    "details": {
      "createdCount": 1,
      "cardCount": 1,
      "cardTypes": [
        "forward"
      ],
      "cardItemCount": 0,
      "rows": [
        {
          "remId": "PX8vPmugge6Rjliyi",
          "text": "- __codex_probe__-mr2sl4yr Concept",
          "cards": [
            {
              "id": "tQwz1iCCGhghMwTRq",
              "remId": "PX8vPmugge6Rjliyi",
              "type": "forward",
              "createdAt": 1782953683984,
              "nextRepetitionTime": 1782953683984
            }
          ],
          "isCardItem": false
        }
      ]
    }
  },
  {
    "capability": "descriptorCard",
    "status": "PASS",
    "method": "plugin.rem.createTreeWithMarkdown using RemNote descriptor delimiter ;;",
    "details": {
      "createdCount": 3,
      "cardCount": 2,
      "cardTypes": [
        "forward",
        "forward"
      ],
      "cardItemCount": 0,
      "rows": [
        {
          "remId": "d2O1RlQvYhvN78M1K",
          "text": "__codex_probe__-mr2sl4yr Parent Concept",
          "cards": [],
          "isCardItem": false
        },
        {
          "remId": "h0xlRTRWxOuHqf5ub",
          "text": "attribute",
          "cards": [
            {
              "id": "nhuidjV7udHbT1cUW",
              "remId": "h0xlRTRWxOuHqf5ub",
              "type": "forward",
              "createdAt": 1782953683995,
              "nextRepetitionTime": 1782953683995
            }
          ],
          "isCardItem": false
        },
        {
          "remId": "h0xlRTRWxOuHqf5ub",
          "text": "attribute",
          "cards": [
            {
              "id": "nhuidjV7udHbT1cUW",
              "remId": "h0xlRTRWxOuHqf5ub",
              "type": "forward",
              "createdAt": 1782953683995,
              "nextRepetitionTime": 1782953683995
            }
          ],
          "isCardItem": false
        }
      ]
    }
  },
  {
    "capability": "clozeCard",
    "status": "PASS",
    "method": "richText.applyTextFormatToRange(..., 'cloze') + rem.setEnablePractice",
    "details": {
      "remId": "FxXudr4Ukgb7Oraj6",
      "cardCount": 1,
      "clozeCount": 1,
      "cardTypes": [
        {
          "clozeId": "4293619728168674"
        }
      ],
      "cards": [
        {
          "id": "xIVY29KyXwsbcdmba",
          "remId": "FxXudr4Ukgb7Oraj6",
          "type": {
            "clozeId": "4293619728168674"
          },
          "createdAt": 1782953689289,
          "nextRepetitionTime": 1782953689289
        }
      ]
    }
  },
  {
    "capability": "multiLineCard",
    "status": "PASS",
    "method": "plugin.rem.createTreeWithMarkdown using RemNote multi-line delimiter >>>",
    "details": {
      "createdCount": 5,
      "cardCount": 1,
      "cardTypes": [
        "forward"
      ],
      "cardItemCount": 4,
      "rows": [
        {
          "remId": "7oT5MZugsrJ9tBGo7",
          "text": "__codex_probe__-mr2sl4yr multi-line prompt",
          "cards": [
            {
              "id": "v3Riyoqq5vz78SWqr",
              "remId": "7oT5MZugsrJ9tBGo7",
              "type": "forward",
              "createdAt": 1782953689339,
              "nextRepetitionTime": 1782953689339
            }
          ],
          "isCardItem": false
        },
        {
          "remId": "aT4JKYzYYXEiomKFZ",
          "text": "__codex_probe__-mr2sl4yr item one",
          "cards": [],
          "isCardItem": true
        },
        {
          "remId": "rHi2RdOAMULcxbsFA",
          "text": "__codex_probe__-mr2sl4yr item two",
          "cards": [],
          "isCardItem": true
        },
        {
          "remId": "aT4JKYzYYXEiomKFZ",
          "text": "__codex_probe__-mr2sl4yr item one",
          "cards": [],
          "isCardItem": true
        },
        {
          "remId": "rHi2RdOAMULcxbsFA",
          "text": "__codex_probe__-mr2sl4yr item two",
          "cards": [],
          "isCardItem": true
        }
      ]
    }
  },
  {
    "capability": "listAnswerCard",
    "status": "PASS",
    "method": "plugin.rem.createTreeWithMarkdown using RemNote list-answer delimiter >>1.",
    "details": {
      "createdCount": 5,
      "cardCount": 1,
      "cardTypes": [
        "forward"
      ],
      "cardItemCount": 4,
      "rows": [
        {
          "remId": "gwCz0z9S3wkdbXlw4",
          "text": "__codex_probe__-mr2sl4yr list prompt",
          "cards": [
            {
              "id": "W0MjiXjGJGFeRqMds",
              "remId": "gwCz0z9S3wkdbXlw4",
              "type": "forward",
              "createdAt": 1782953694437,
              "nextRepetitionTime": 1782953694437
            }
          ],
          "isCardItem": false
        },
        {
          "remId": "aNYXbdG8Ko0UDJiNf",
          "text": "__codex_probe__-mr2sl4yr first",
          "cards": [],
          "isCardItem": true
        },
        {
          "remId": "WVrYxThNkxuCVzMrh",
          "text": "__codex_probe__-mr2sl4yr second",
          "cards": [],
          "isCardItem": true
        },
        {
          "remId": "aNYXbdG8Ko0UDJiNf",
          "text": "__codex_probe__-mr2sl4yr first",
          "cards": [],
          "isCardItem": true
        },
        {
          "remId": "WVrYxThNkxuCVzMrh",
          "text": "__codex_probe__-mr2sl4yr second",
          "cards": [],
          "isCardItem": true
        }
      ]
    }
  },
  {
    "capability": "imageOcclusion",
    "status": "UNSUPPORTED",
    "method": "SDK method introspection",
    "details": {
      "methods": []
    },
    "workaround": "Use RemNote's native UI for image occlusion or store images/context for user-assisted occlusion until the SDK exposes a scriptable API."
  },
  {
    "capability": "properties",
    "status": "PASS",
    "method": "rem.addPowerup + rem.setPowerupProperty + rem.getPowerupPropertyAsRichText",
    "details": {
      "remId": "Yo0xe9PSGnlH88GRf",
      "value": "https://example.com/__codex_probe__-mr2sl4yr"
    }
  },
  {
    "capability": "portals",
    "status": "PASS",
    "method": "rem.addToPortal",
    "details": {
      "includedRemId": "NXawIa690KfClw7Mg",
      "portalHostRemId": "mrSWALavlWxKGtgY0",
      "caveat": "Probe verifies SDK call succeeds, not visual portal rendering."
    }
  },
  {
    "capability": "orderedInsertion",
    "status": "PASS",
    "method": "rem.setParent(parent, positionAmongstSiblings)",
    "details": {
      "expected": [
        "SZA3JUJpGA4hDMzhQ",
        "YtN2cg1rfguzWFwUR",
        "KBpcvILHv9sl0ZxKq"
      ],
      "observed": [
        "SZA3JUJpGA4hDMzhQ",
        "YtN2cg1rfguzWFwUR",
        "KBpcvILHv9sl0ZxKq"
      ]
    }
  },
  {
    "capability": "nativeTrashRestore",
    "status": "UNSUPPORTED",
    "method": "SDK method introspection",
    "details": {
      "methods": []
    },
    "workaround": "Continue tombstone-by-move; snapshot restore is copy-only and not true undo."
  },
  {
    "capability": "driftPrimitives",
    "status": "PASS",
    "method": "rem.updatedAt + SDK method introspection",
    "details": {
      "createdAtType": "number",
      "updatedAtType": "number",
      "updatedAtChanged": false,
      "contentHashField": false,
      "changeFeedMethods": [
        "waitForInitialSync"
      ]
    }
  },
  {
    "capability": "mediaDataUriImage",
    "status": "FAIL",
    "method": "richText.image(dataUri) + setText + optional toHTML/findAllExternalURLs",
    "details": {
      "remId": "yE41zTt0szIsLxMeI",
      "text": "",
      "html": "<img src=\"https://remnote-user-data.s3.amazonaws.com/about:blank\" width=\"0\" height=\"0\"/>",
      "urls": []
    }
  }
]
```

## Cleanup

- Probe content was created under `__codex_probe__-mr2sl4yr`.
- Plugin soft-delete opId: `__codex_probe__-mr2sl4yr-tombstone`.
- Hard-delete cleanup: `emptyTrash_ok` 

## Downstream Assumptions

- If `imageOcclusion` is `UNSUPPORTED`, RemNoteConnect should not promise fully automated image occlusion authoring; use RemNote UI or a user-assisted workflow until the SDK exposes a scriptable API.
- If imported Concept/Descriptor/Multi-line/List syntax is `FAIL`, generated cards should use explicit SDK front/back or cloze paths and document the divergence from RemNote paste/import syntax.
- If no change-feed methods appear under `driftPrimitives`, M2 sync should use chunked `getAll` snapshot sweeps plus content hashes and a stale-index marker. In this probe, `updatedAt` existed but did not change immediately after `setText`, so do not treat it as sufficient by itself until a longer direct-edit probe proves it.
- Data-URI images failed in the live rich-text image probe. Prefer daemon-local file URLs or RemNote-supported uploaded media URLs for generated/imported image content; media probes verify serialization and URL retention, not visual rendering in every RemNote surface.
