/**
 * computer-use server 的 MCP tool schema。
 * 结构上对齐 claude-for-chrome-mcp/src/browserTools.ts，
 * 也就是普通的 `Tool` 形状对象字面量，不使用 zod。
 *
 * 坐标描述会在构建工具列表时，根据 `chicago_coordinate_mode` gate 固化进去。
 * 模型在参数说明里只会看到一种坐标约定，不会知道另一种模式存在。
 * host（`serverDef.ts`）在 `scaleCoord` 中也必须读取同一个冻结值，
 * 否则点击会落到错误位置。
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { CoordinateMode } from "./types.js";

// 修改任何面向模型的坐标文案前，先看 packages/desktop/computer-use-mcp/COORDINATES.md。
// Chrome 的 browserTools.ts:143 是参考表述：
// 使用“距离左边缘多少像素”这种说法，不讲几何推导，也不给模型做数学的额外数字。
const COORD_DESC: Record<CoordinateMode, { x: string; y: string }> = {
  pixels: {
    x: "Horizontal pixel position read directly from the most recent screenshot image, measured from the left edge. The server handles all scaling.",
    y: "Vertical pixel position read directly from the most recent screenshot image, measured from the top edge. The server handles all scaling.",
  },
  normalized_0_100: {
    x: "Horizontal position as a percentage of screen width, 0.0–100.0 (0 = left edge, 100 = right edge).",
    y: "Vertical position as a percentage of screen height, 0.0–100.0 (0 = top edge, 100 = bottom edge).",
  },
};

const FRONTMOST_GATE_DESC =
  "The frontmost application must be in the session allowlist at the time of this call, or this tool returns an error and does nothing.";

/**
 * `computer_batch`、`teach_step` 与 `teach_batch` 中 `actions` 数组的单项 schema。
 * 三者都走同一条 `dispatchAction` 路径，也共享相同校验逻辑，
 * 因此这里的 enum 必须与 toolCalls.ts 中的 `BATCHABLE_ACTIONS` 保持同步。
 */
const BATCH_ACTION_ITEM_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "key",
        "type",
        "mouse_move",
        "left_click",
        "left_click_drag",
        "right_click",
        "middle_click",
        "double_click",
        "triple_click",
        "scroll",
        "hold_key",
        "screenshot",
        "cursor_position",
        "left_mouse_down",
        "left_mouse_up",
        "wait",
      ],
      description: "The action to perform.",
    },
    coordinate: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        "(x, y) for click/mouse_move/scroll/left_click_drag end point.",
    },
    start_coordinate: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        "(x, y) drag start — left_click_drag only. Omit to drag from current cursor.",
    },
    text: {
      type: "string",
      description:
        "For type: the text. For key/hold_key: the chord string. For click/scroll: modifier keys to hold.",
    },
    scroll_direction: {
      type: "string",
      enum: ["up", "down", "left", "right"],
    },
    scroll_amount: { type: "integer", minimum: 0, maximum: 100 },
    duration: {
      type: "number",
      description: "Seconds (0–100). For hold_key/wait.",
    },
    repeat: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "For key: repeat count.",
    },
  },
  required: ["action"],
};

/**
 * 构建工具列表。
 * 它按 capabilities 与 coordinate mode 参数化，确保文案真实且无歧义。
 *
 * `coordinateMode` 必须与 host 在运行期传给 `scaleCoord` 的值完全一致，
 * 二者都应读取同一个加载时冻结的 gate 常量。
 *
 * `installedAppNames` 是可选的、已预清洗的 app 展示名列表，
 * 会被枚举进 `request_access` 的描述里。
 * 调用方负责清洗它（长度上限、字符白名单、排序、数量上限）；
 * 这个函数只会原样拼接进去。省略时则回退到通用的
 * “display names or bundle IDs” 表述。
 */
export function buildComputerUseTools(
  caps: {
    screenshotFiltering: "native" | "none";
    platform: "darwin" | "win32";
    /** 是否包含 request_teach_access 与 teach_step。会在 server 构造时读取一次。 */
    teachMode?: boolean;
  },
  coordinateMode: CoordinateMode,
  installedAppNames?: string[],
): Tool[] {
  const coord = COORD_DESC[coordinateMode];

  // request_access 与 request_teach_access 共用的提示后缀。
  // 两者走的是同一条 resolveRequestedApps 路径，因此模型应看到相同的枚举列表。
  const installedAppsHint =
    installedAppNames && installedAppNames.length > 0
      ? ` Available applications on this machine: ${installedAppNames.join(", ")}.`
      : "";

  // [x, y] 元组：所有 click/move/scroll 工具共用的参数形状。
  const coordinateTuple = {
    type: "array",
    items: { type: "number" },
    minItems: 2,
    maxItems: 2,
    description: `(x, y): ${coord.x}`,
  };
  // 点击期间按住的修饰键。5 种 click 变体共用。
  const clickModifierText = {
    type: "string",
    description:
      'Modifier keys to hold during the click (e.g. "shift", "ctrl+shift"). Supports the same syntax as the key tool.',
  };

  const screenshotDesc =
    caps.screenshotFiltering === "native"
      ? "Take a screenshot of the primary display. Applications not in the session allowlist are excluded at the compositor level — only granted apps and the desktop are visible."
      : "Take a screenshot of the primary display. On this platform, screenshots are NOT filtered — all open windows are visible. Input actions targeting apps not in the session allowlist are rejected.";

  return [
    {
      name: "request_access",
      description:
        "Request user permission to control a set of applications for this session. Must be called before any other tool in this server. " +
        "The user sees a single dialog listing all requested apps and either allows the whole set or denies it. " +
        "Call this again mid-session to add more apps; previously granted apps remain granted. " +
        "Returns the granted apps, denied apps, and screenshot filtering capability.",
      inputSchema: {
        type: "object" as const,
        properties: {
          apps: {
            type: "array",
            items: { type: "string" },
            description:
              "Application display names (e.g. \"Slack\", \"Calendar\") or bundle identifiers (e.g. \"com.tinyspeck.slackmacgap\"). Display names are resolved case-insensitively against installed apps." +
              installedAppsHint,
          },
          reason: {
            type: "string",
            description:
              "One-sentence explanation shown to the user in the approval dialog. Explain the task, not the mechanism.",
          },
          clipboardRead: {
            type: "boolean",
            description:
              "Also request permission to read the user's clipboard (separate checkbox in the dialog).",
          },
          clipboardWrite: {
            type: "boolean",
            description:
              "Also request permission to write the user's clipboard. When granted, multi-line `type` calls use the clipboard fast path.",
          },
          systemKeyCombos: {
            type: "boolean",
            description:
              "Also request permission to send system-level key combos (quit app, switch app, lock screen). Without this, those specific combos are blocked.",
          },
        },
        required: ["apps", "reason"],
      },
    },

    {
      name: "screenshot",
      description:
        screenshotDesc +
        " Returns an error if the allowlist is empty. The returned image is what subsequent click coordinates are relative to.",
      inputSchema: {
        type: "object" as const,
        properties: {
          save_to_disk: {
            type: "boolean",
            description:
              "Save the image to disk so it can be attached to a message for the user. Returns the saved path in the tool result. Only set this when you intend to share the image — screenshots you're just looking at don't need saving.",
          },
        },
        required: [],
      },
    },

    {
      name: "zoom",
      description:
        "Take a higher-resolution screenshot of a specific region of the last full-screen screenshot. Use this liberally to inspect small text, button labels, or fine UI details that are hard to read in the downsampled full-screen image. " +
        "IMPORTANT: Coordinates in subsequent click calls always refer to the full-screen screenshot, never the zoomed image. This tool is read-only for inspecting detail.",
      inputSchema: {
        type: "object" as const,
        properties: {
          region: {
            type: "array",
            items: { type: "integer" },
            minItems: 4,
            maxItems: 4,
            description:
              "(x0, y0, x1, y1): Rectangle to zoom into, in the coordinate space of the most recent full-screen screenshot. x0,y0 = top-left, x1,y1 = bottom-right.",
          },
          save_to_disk: {
            type: "boolean",
            description:
              "Save the image to disk so it can be attached to a message for the user. Returns the saved path in the tool result. Only set this when you intend to share the image.",
          },
        },
        required: ["region"],
      },
    },

    {
      name: "left_click",
      description: `Left-click at the given coordinates. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "double_click",
      description: `Double-click at the given coordinates. Selects a word in most text editors. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "triple_click",
      description: `Triple-click at the given coordinates. Selects a line in most text editors. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "right_click",
      description: `Right-click at the given coordinates. Opens a context menu in most applications. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "middle_click",
      description: `Middle-click (scroll-wheel click) at the given coordinates. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "type",
      description: `Type text into whatever currently has keyboard focus. ${FRONTMOST_GATE_DESC} Newlines are supported. For keyboard shortcuts use \`key\` instead.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Text to type." },
        },
        required: ["text"],
      },
    },

    {
      name: "key",
      description:
        `Press a key or key combination (e.g. "return", "escape", "cmd+a", "ctrl+shift+tab"). ${FRONTMOST_GATE_DESC} ` +
        "System-level combos (quit app, switch app, lock screen) require the `systemKeyCombos` grant — without it they return an error. All other combos work.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: 'Modifiers joined with "+", e.g. "cmd+shift+a".',
          },
          repeat: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Number of times to repeat the key press. Default is 1.",
          },
        },
        required: ["text"],
      },
    },

    {
      name: "scroll",
      description: `Scroll at the given coordinates. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          scroll_direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Direction to scroll.",
          },
          scroll_amount: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description: "Number of scroll ticks.",
          },
        },
        required: ["coordinate", "scroll_direction", "scroll_amount"],
      },
    },

    {
      name: "left_click_drag",
      description: `Press, move to target, and release. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: {
            ...coordinateTuple,
            description: `(x, y) end point: ${coord.x}`,
          },
          start_coordinate: {
            ...coordinateTuple,
            description: `(x, y) start point. If omitted, drags from the current cursor position. ${coord.x}`,
          },
        },
        required: ["coordinate"],
      },
    },

    {
      name: "mouse_move",
      description: `Move the mouse cursor without clicking. Useful for triggering hover states. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "open_application",
      description:
        "Bring an application to the front, launching it if necessary. The target application must already be in the session allowlist — call request_access first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          app: {
            type: "string",
            description:
              "Display name (e.g. \"Slack\") or bundle identifier (e.g. \"com.tinyspeck.slackmacgap\").",
          },
        },
        required: ["app"],
      },
    },

    {
      name: "switch_display",
      description:
        "Switch which monitor subsequent screenshots capture. Use this when the " +
        "application you need is on a different monitor than the one shown. " +
        "The screenshot tool tells you which monitor it captured and lists " +
        "other attached monitors by name — pass one of those names here. " +
        "After switching, call screenshot to see the new monitor. " +
        'Pass "auto" to return to automatic monitor selection.',
      inputSchema: {
        type: "object" as const,
        properties: {
          display: {
            type: "string",
            description:
              'Monitor name from the screenshot note (e.g. "Built-in Retina Display", ' +
              '"LG UltraFine"), or "auto" to re-enable automatic selection.',
          },
        },
        required: ["display"],
      },
    },

    {
      name: "list_granted_applications",
      description:
        "List the applications currently in the session allowlist, plus the active grant flags and coordinate mode. No side effects.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "read_clipboard",
      description:
        "Read the current clipboard contents as text. Requires the `clipboardRead` grant.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "write_clipboard",
      description:
        "Write text to the clipboard. Requires the `clipboardWrite` grant.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },

    {
      name: "wait",
      description: "Wait for a specified duration.",
      inputSchema: {
        type: "object" as const,
        properties: {
          duration: {
            type: "number",
            description: "Duration in seconds (0–100).",
          },
        },
        required: ["duration"],
      },
    },

    {
      name: "cursor_position",
      description:
        "Get the current mouse cursor position. Returns image-pixel coordinates relative to the most recent screenshot, or logical points if no screenshot has been taken.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "hold_key",
      description:
        `Press and hold a key or key combination for the specified duration, then release. ${FRONTMOST_GATE_DESC} ` +
        "System-level combos require the `systemKeyCombos` grant.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: 'Key or chord to hold, e.g. "space", "shift+down".',
          },
          duration: {
            type: "number",
            description: "Duration in seconds (0–100).",
          },
        },
        required: ["text", "duration"],
      },
    },

    {
      name: "left_mouse_down",
      description:
        `Press the left mouse button at the current cursor position and leave it held. ${FRONTMOST_GATE_DESC} ` +
        "Use mouse_move first to position the cursor. Call left_mouse_up to release. Errors if the button is already held.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "left_mouse_up",
      description:
        `Release the left mouse button at the current cursor position. ${FRONTMOST_GATE_DESC} ` +
        "Pairs with left_mouse_down. Safe to call even if the button is not currently held.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "computer_batch",
      description:
        "Execute a sequence of actions in ONE tool call. Each individual tool call requires a model→API round trip (seconds); " +
        "batching a predictable sequence eliminates all but one. Use this whenever you can predict the outcome of several actions ahead — " +
        "e.g. click a field, type into it, press Return. Actions execute sequentially and stop on the first error. " +
        `${FRONTMOST_GATE_DESC} The frontmost check runs before EACH action inside the batch — if an action opens a non-allowed app, the next action's gate fires and the batch stops there. ` +
        "Mid-batch screenshot actions are allowed for inspection but coordinates in subsequent clicks always refer to the PRE-BATCH full-screen screenshot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          actions: {
            type: "array",
            minItems: 1,
            items: BATCH_ACTION_ITEM_SCHEMA,
            description:
              'List of actions. Example: [{"action":"left_click","coordinate":[100,200]},{"action":"type","text":"hello"},{"action":"key","text":"Return"}]',
          },
        },
        required: ["actions"],
      },
    },

    ...(caps.teachMode ? buildTeachTools(coord, installedAppsHint) : []),
  ];
}

/**
 * teach-mode 专用工具。
 * 单独拆出来是为了让上面的 spread 保持为单个表达式；
 * 同时接收 `coord`，让 `teach_step.anchor` 的描述与 click 坐标使用同一套冻结坐标文案；
 * 也接收 `installedAppsHint`，让 `request_teach_access.apps` 与
 * `request_access.apps` 拿到相同的枚举提示。
 */
function buildTeachTools(
  coord: { x: string; y: string },
  installedAppsHint: string,
): Tool[] {
  // teach_step（顶层）与 teach_batch（steps[] 内部项）共用。
  // 它依赖 coord，因此定义在这个工厂函数内部。
  const teachStepProperties = {
    explanation: {
      type: "string",
      description:
        "Tooltip body text. Explain what the user is looking at and why it matters. " +
        "This is the ONLY place the user sees your words — be complete but concise.",
    },
    next_preview: {
      type: "string",
      description:
        "One line describing exactly what will happen when the user clicks Next. " +
        'Example: "Next: I\'ll click Create Bucket and type the name." ' +
        "Shown below the explanation in a smaller font.",
    },
    anchor: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        `(x, y) — where the tooltip arrow points. ${coord.x} ` +
        "Omit to center the tooltip with no arrow (for general-context steps).",
    },
    actions: {
      type: "array",
      // 允许空数组，对应“先读说明，再点 Next”的纯讲解步骤。
      items: BATCH_ACTION_ITEM_SCHEMA,
      description:
        "Actions to execute when the user clicks Next. Same item schema as computer_batch.actions. " +
        "Empty array is valid for purely explanatory steps. Actions run sequentially and stop on first error.",
    },
  } as const;

  return [
    {
      name: "request_teach_access",
      description:
        "Request permission to guide the user through a task step-by-step with on-screen tooltips. " +
        "Use this INSTEAD OF request_access when the user wants to LEARN how to do something " +
        '(phrases like "teach me", "walk me through", "show me how", "help me learn"). ' +
        "On approval the main Claude window hides and a fullscreen tooltip overlay appears. " +
        "You then call teach_step repeatedly; each call shows one tooltip and waits for the user to click Next. " +
        "Same app-allowlist semantics as request_access, but no clipboard/system-key flags. " +
        "Teach mode ends automatically when your turn ends.",
      inputSchema: {
        type: "object" as const,
        properties: {
          apps: {
            type: "array",
            items: { type: "string" },
            description:
              'Application display names (e.g. "Slack", "Calendar") or bundle identifiers. Resolved case-insensitively against installed apps.' +
              installedAppsHint,
          },
          reason: {
            type: "string",
            description:
              'What you will be teaching. Shown in the approval dialog as "Claude wants to guide you through {reason}". Keep it short and task-focused.',
          },
        },
        required: ["apps", "reason"],
      },
    },

    {
      name: "teach_step",
      description:
        "Show one guided-tour tooltip and wait for the user to click Next. On Next, execute the actions, " +
        "take a fresh screenshot, and return both — you do NOT need a separate screenshot call between steps. " +
        "The returned image shows the state after your actions ran; anchor the next teach_step against it. " +
        "IMPORTANT — the user only sees the tooltip during teach mode. Put ALL narration in `explanation`. " +
        "Text you emit outside teach_step calls is NOT visible until teach mode ends. " +
        "Pack as many actions as possible into each step's `actions` array — the user waits through " +
        "the whole round trip between clicks, so one step that fills a form beats five steps that fill one field each. " +
        "Returns {exited:true} if the user clicks Exit — do not call teach_step again after that. " +
        "Take an initial screenshot before your FIRST teach_step to anchor it.",
      inputSchema: {
        type: "object" as const,
        properties: teachStepProperties,
        required: ["explanation", "next_preview", "actions"],
      },
    },

    {
      name: "teach_batch",
      description:
        "Queue multiple teach steps in one tool call. Parallels computer_batch: " +
        "N steps → one model↔API round trip instead of N. Each step still shows a tooltip " +
        "and waits for the user's Next click, but YOU aren't waiting for a round trip between steps. " +
        "You can call teach_batch multiple times in one tour — treat each batch as one predictable " +
        "SEGMENT (typically: all the steps on one page). The returned screenshot shows the state " +
        "after the batch's final actions; anchor the NEXT teach_batch against it. " +
        "WITHIN a batch, all anchors and click coordinates refer to the PRE-BATCH screenshot " +
        "(same invariant as computer_batch) — for steps 2+ in a batch, either omit anchor " +
        "(centered tooltip) or target elements you know won't have moved. " +
        "Good pattern: batch 5 tooltips on page A (last step navigates) → read returned screenshot → " +
        "batch 3 tooltips on page B → done. " +
        "Returns {exited:true, stepsCompleted:N} if the user clicks Exit — do NOT call again after that; " +
        "{stepsCompleted, stepFailed, ...} if an action errors mid-batch; " +
        "otherwise {stepsCompleted, results:[...]} plus a final screenshot. " +
        "Fall back to individual teach_step calls when you need to react to each intermediate screenshot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: teachStepProperties,
              required: ["explanation", "next_preview", "actions"],
            },
            description:
              "Ordered steps. Validated upfront — a typo in step 5 errors before any tooltip shows.",
          },
        },
        required: ["steps"],
      },
    },
  ];
}
