import type { Terminal } from "@xterm/xterm";

/** 是否为 macOS（Tauri 桌面壳走 WKWebView） */
function isMacPlatform(): boolean {
  return /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
}

function isWhitespaceOnly(data: string): boolean {
  // 只匹配「空格族」（半角空格 / 全角空格 / 不间断空格），排除 Tab（\t）与
  // 控制字符（\r\n\f\v）：\s 会把 Tab/回车误判为纯空白，Tab 在 onData 空白
  // 拦截分支被静默丢弃 → shell 补全（Tab 提示）失效；回车被丢 → 命令不执行。
  // Tab 由 safeWrite 内的 120ms 去重逻辑单独放行，不受此判定影响。
  return /^[ \u00a0\u3000]+$/.test(data);
}

/** 拼音音节分隔符 / 弯撇号：中英切换时常被 IME 误提交（main → mai'n） */
function isImeApostrophe(data: string): boolean {
  return data === "'" || data === "\u2019" || data === "\u02bc";
}


/** Vim 等全屏 TUI 会切到 alternate buffer */
function isTuiActive(term: Terminal): boolean {
  try {
    return term.buffer.active.type !== term.buffer.normal.type;
  } catch {
    return false;
  }
}

function syncTuiChrome(term: Terminal, active: boolean) {
  const root = term.element?.closest(".terminal-host");
  root?.classList.toggle("tui-mode", active);
  const textarea = term.textarea;
  if (!textarea) return;
  if (active) {
    textarea.setAttribute("inputmode", "none");
    textarea.setAttribute("lang", "en");
    textarea.setAttribute("autocorrect", "off");
    textarea.setAttribute("autocapitalize", "off");
  } else {
    textarea.removeAttribute("inputmode");
    textarea.removeAttribute("lang");
  }
}

/**
 * 修复 macOS WKWebView + 中文输入法下 xterm 的输入缺陷；
 * 进入 alternate buffer（Vim 等 TUI）时自动 bypass，避免 i 模式/方向键失效。
 *
 * @returns dispose
 */
export function attachTerminalInputBridge(
  term: Terminal,
  write: (data: string) => void,
): () => void {
  const cleanups: Array<() => void> = [];
  let tuiMode = isTuiActive(term);
  syncTuiChrome(term, tuiMode);

  const textarea = term.textarea;
  if (textarea) {
    textarea.setAttribute("spellcheck", "false");
    textarea.setAttribute("autocapitalize", "off");
    textarea.setAttribute("autocomplete", "off");
    textarea.setAttribute("autocorrect", "off");
  }

  const bufferDisp = term.buffer.onBufferChange(() => {
    const next = isTuiActive(term);
    if (next === tuiMode) return;
    tuiMode = next;
    syncTuiChrome(term, tuiMode);
    if (tuiMode && textarea) textarea.value = "";
  });
  cleanups.push(() => bufferDisp.dispose());

  if (!isMacPlatform() || !textarea) {
    const dataDisp = term.onData((data) => {
      if (tuiMode) {
        write(data);
        return;
      }
      write(data);
    });
    cleanups.push(() => dataDisp.dispose());
    cleanups.push(() => syncTuiChrome(term, false));
    return () => {
      for (const fn of cleanups) fn();
    };
  }

  const ime = {
    keyDownSeen: false,
    last229At: 0,
    lastDeleteAt: 0,
    lastNonAsciiCommitAt: 0,
    lastCompositionEndAt: 0,
    composing: false,
    lastWriteData: "",
    lastWriteAt: 0,
    lastTabAt: 0,
    /** 用户真实按下空格键（Space）的时刻：onData 空白放行的唯一凭据 */
    lastSpaceKeyDownAt: 0,
    /**
     * 删除/Tab 键 keydown 后置 true：在 beforeinput 源头吞掉浏览器对 textarea
     * 的误插（WKWebView 下 keydown 的 preventDefault 不可靠）。
     * keydown 与 beforeinput 严格 1:1 配对，单次标志安全可靠。
     */
    suppressNextInsert: false,
  };

  function rawWrite(data: string) {
    if (!data) return;
    write(data);
  }

  function safeWrite(data: string) {
    if (!data) return;
    if (tuiMode) {
      rawWrite(data);
      return;
    }
    const now = performance.now();
    // 打包环境 WKWebView 下 Tab 会双发：同一次补全被触发两次，
    // 远程 shell 补全两次导致路径多出斜杠（如 `cd ser` + Tab → `cd services/` 后
    // 又被补全成 `services//`）。连续 Tab 去重，只放行第一次；
    // dev 下单发不受影响（手动连按切换补全候选的间隔通常大于该窗口）。
    if (data === "\t") {
      if (now - ime.lastTabAt < 120) return;
      ime.lastTabAt = now;
    }
    if (
      data.length <= 2 &&
      isWhitespaceOnly(data) &&
      data === ime.lastWriteData &&
      now - ime.lastWriteAt < 50
    ) {
      return;
    }
    if (data === ime.lastWriteData && now - ime.lastWriteAt < 28) {
      return;
    }
    ime.lastWriteData = data;
    ime.lastWriteAt = now;
    // 提交文本残留清理：xterm 经 triggerDataEvent 派发（如 IME 组合提交）后，
    // textarea.value 里的提交文本仍残留。不清掉的话，打包环境（WKWebView
    // preventDefault 失效）按 Backspace 时，IME 会把残留字符替换为等长空格，
    // 再经 xterm _inputEvent 二次派发泄漏（「删除键变空格」根因）。这里在
    // 派发完成后同步清空，与 xterm 的 setTimeout 读取（compositionend 路径）
    // 无竞争——onData 是同步回调，先于任何宏任务。
    const tv = textarea?.value;
    if (tv && data === tv) {
      textarea!.value = "";
    }
    write(data);
  }

  const dataDisp = term.onData((data) => {
    if (tuiMode) {
      rawWrite(data);
      return;
    }
    const now = performance.now();
    // 删除控制字符：xterm custom handler 返回 true 后经 onData 派发，
    // 用 rawWrite 绕过 safeWrite 去重，保证按住删除键可连续删除。
    if (data === "\x7f" || data === "\x1b[3~") {
      rawWrite(data);
      return;
    }
    // 删除/Tab 后的误插空白兜底（主防线在 beforeinput，此处为副防线）。
    // 纯空白数据只认「用户真实按过空格键」：IME 把 textarea 残留替换为等长空格
    // 后经 CompositionHelper 的 _finalizeComposition / _handleAnyTextareaChanges
    // 直接 triggerDataEvent 派发的空白，没有任何对应空格键 keydown——此前用
    // 「删除键 keydown 时间窗」拦截，但删除键 keydown 恰恰被 IME 吞掉，时间窗
    // 全部失效。改用空格键追踪后不依赖任何被吞的信号，彻底切断泄漏路径。
    if (isWhitespaceOnly(data)) {
      const realSpaceKey = now - ime.lastSpaceKeyDownAt < 400;
      if (ime.composing || !realSpaceKey) {
        return;
      }
    }
    if (
      isImeApostrophe(data) &&
      (ime.composing ||
        now - ime.lastCompositionEndAt < 450 ||
        now - ime.last229At < 450)
    ) {
      return;
    }
    safeWrite(data);
  });
  cleanups.push(() => dataDisp.dispose());

  const markCompositionStart = () => {
    if (tuiMode) return;
    ime.composing = true;
  };
  const markCompositionEnd = () => {
    ime.composing = false;
    ime.lastCompositionEndAt = performance.now();
    // 不能在此同步清空 textarea.value：xterm 的 _finalizeComposition 在
    // compositionend 后用 setTimeout(0) 读取 value 派发组合提交内容，
    // 同步清空会让 xterm 读到空串 → 中文/拼音提交内容丢失（实测视频确认）。
    // 残留清理改由 safeWrite 派发后（data === textarea.value）统一完成。
  };
  textarea.addEventListener("compositionstart", markCompositionStart, true);
  textarea.addEventListener("compositionend", markCompositionEnd, true);
  cleanups.push(() => {
    textarea.removeEventListener(
      "compositionstart",
      markCompositionStart,
      true,
    );
    textarea.removeEventListener("compositionend", markCompositionEnd, true);
  });

  const host = term.element;
  if (host) {
    const onImeCommitInput = (ev: Event) => {
      if (tuiMode) return;
      if (ev.target !== textarea) return;
      const ie = ev as InputEvent;
      if (ie.isComposing) {
        // 组合态中的空白 input：IME 退格把拼音替换为等长空格占位（macOS 拼音
        // 行为），放行会经 xterm _inputEvent 二次派发泄漏（「删除键变空格」根因）。
        // 组合态空格只有泄漏这一个来源（选字/上屏不产生空格 input），安全拦截。
        if (ie.data && isWhitespaceOnly(ie.data)) {
          ev.stopPropagation();
        }
        return;
      }
      const now = performance.now();
      // 删除/Tab 后的误插空白兜底（主防线在 beforeinput，此处为副防线）：
      // 打包环境 preventDefault 不可靠时，浏览器对 textarea 的 input 事件
      // 可能绕过 beforeinput 直达此处。删除时间窗内的空白/删除类 input 一律拦截。
      if (ime.suppressNextInsert || now - ime.lastDeleteAt < 300) {
        ime.suppressNextInsert = false;
        if (
          !ie.data ||
          isWhitespaceOnly(ie.data) ||
          ie.inputType.startsWith("delete")
        ) {
          ev.stopPropagation();
          textarea.value = "";
          return;
        }
      }
      if (ie.inputType !== "insertText" || !ie.data) return;
      if (isWhitespaceOnly(ie.data) || isImeApostrophe(ie.data)) {
        ev.stopPropagation();
        textarea.value = "";
        return;
      }
      // ASCII 输入残留：字符已由 keydown 派发，此处只需清掉浏览器写入 textarea
      // 的残留（打包环境 preventDefault 失效）。不清的话，后续 Backspace 会被
      // IME 替换为等长空格泄漏。组合态（isComposing）已在入口排除，清空安全。
      if (!/[^\x00-\x7f]/.test(ie.data)) {
        textarea.value = "";
        return;
      }
      ime.lastNonAsciiCommitAt = performance.now();
      if (term.options.screenReaderMode) return;
      if (performance.now() - ime.last229At < 50) return;
      if (performance.now() - ime.lastCompositionEndAt < 100) return;
      if (!ie.composed || !ime.keyDownSeen) return;
      safeWrite(ie.data);
      ev.stopPropagation();
      textarea.value = "";
    };
    host.addEventListener("input", onImeCommitInput, true);
    cleanups.push(() =>
      host.removeEventListener("input", onImeCommitInput, true),
    );
  }

  const onBeforeInput = (ev: InputEvent) => {
    if (tuiMode) return;
    if (ev.isComposing || ime.composing) return;
    // 主防线：删除/Tab 键 keydown 后，浏览器试图往 textarea 插入内容时
    // 在源头拦截。beforeinput 先于 input 触发，preventDefault 可阻止
    // textarea 插入 -> 断绝 xterm _inputEvent 二次派发空白的路径。
    // keydown 与 beforeinput 严格 1:1 配对，单次标志安全可靠。
    if (ime.suppressNextInsert) {
      ime.suppressNextInsert = false;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      textarea.value = "";
      return;
    }
    if (ev.inputType !== "insertText" || !ev.data) return;
    const afterDelete = performance.now() - ime.lastDeleteAt < 300;
    const afterComposition = performance.now() - ime.lastCompositionEndAt < 450;
    const after229 = performance.now() - ime.last229At < 450;
    if (isImeApostrophe(ev.data) && (afterComposition || after229)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      textarea.value = "";
      return;
    }
    if (!isWhitespaceOnly(ev.data)) return;
    if (afterDelete || afterComposition) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      textarea.value = "";
    }
  };
  textarea.addEventListener("beforeinput", onBeforeInput, true);
  cleanups.push(() =>
    textarea.removeEventListener("beforeinput", onBeforeInput, true),
  );

  term.attachCustomKeyEventHandler((e) => {
    // TUI 模式：完全交给 xterm，避免 IME 桥截获 i/j/k/方向键等
    if (tuiMode) return true;

    if (e.type === "keydown") {
      ime.keyDownSeen = true;
      if (e.keyCode === 229) ime.last229At = performance.now();
      // 记录真实空格键按下：onData 空白放行的唯一凭据
      if (e.code === "Space" || e.key === " " || e.keyCode === 32) {
        ime.lastSpaceKeyDownAt = performance.now();
      }
    } else if (e.type === "keyup") {
      ime.keyDownSeen = false;
    }

    if (e.type !== "keydown") return true;

    // 组合态下 xterm 的 CompositionHelper 会把「除 Shift/Ctrl/Alt/CapsLock/229
    // 之外的任意 keydown」当作提交信号并 _finalizeComposition(false)，把当前
    // 拼音缓冲直接派发进 shell。macOS 输入法在 Backspace 编辑拼音后会合成
    // Meta keydown（WeType/系统拼音均存在），若不拦截，拼音（或被 IME 替换为
    // 等长空格的占位内容）就会漏进终端——「删除键变空格」的最终根因。
    // 组合态下把纯修饰键全部交回 IME，阻止 xterm 提前 finalize 组合缓冲。
    const isModifierOnly =
      e.key === "Meta" ||
      e.key === "Control" ||
      e.key === "Shift" ||
      e.key === "Alt" ||
      e.key === "CapsLock" ||
      e.keyCode === 91 ||
      e.keyCode === 92 ||
      e.keyCode === 93 ||
      e.keyCode === 16 ||
      e.keyCode === 17 ||
      e.keyCode === 18 ||
      e.keyCode === 20;
    if (ime.composing && isModifierOnly) {
      return false;
    }

    const isArrow =
      e.code === "ArrowLeft" ||
      e.code === "ArrowRight" ||
      e.code === "ArrowUp" ||
      e.code === "ArrowDown";

    if (isArrow) {
      textarea.value = "";
      if (
        (e.code === "ArrowLeft" || e.code === "ArrowRight") &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.isComposing &&
        !ime.composing &&
        performance.now() - ime.lastNonAsciiCommitAt < 180
      ) {
        return false;
      }
      return true;
    }

    const isBackspace = e.code === "Backspace" || e.key === "Backspace";
    const isDelete = e.code === "Delete" || e.key === "Delete";
    const isTab = e.code === "Tab" || e.key === "Tab";

    // 其他普通按键 keydown：清除误插拦截标志（仅删除/Tab 才需要拦截）
    if (!isBackspace && !isDelete && !isTab) {
      ime.suppressNextInsert = false;
    }

    if (!isBackspace && !isDelete) {
      // Tab 键：设标志让 beforeinput 吞掉浏览器对 textarea 的误插
      if (isTab) ime.suppressNextInsert = true;
      return true;
    }

    ime.lastDeleteAt = performance.now();
    // 设标志：beforeinput 源头拦截浏览器对 textarea 的误插（WKWebView 下
    // keydown 的 preventDefault 不可靠，beforeinput.preventDefault 更可靠）。
    ime.suppressNextInsert = true;

    if (e.isComposing || ime.composing) {
      return false;
    }

    // 非组合态 Backspace/Delete：清掉 textarea 残留（「删除键变空格」的替换源头）
    textarea.value = "";

    // 带修饰键（⌘/⌥/⌃/⇧）的删除（如 shell 的整词删除）交给 xterm 原样处理
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
      return true;
    }

    // 【根治】不再走 xterm 的 _keyDown → evaluateKeyboardEvent 派发路径。
    // macOS 输入法活跃时 Backspace 的 keydown keyCode=229，xterm 的
    // CompositionHelper.keydown() 对非组合态 229 一律走 _handleAnyTextareaChanges
    // 并 return false——evaluateKeyboardEvent 永不执行，\x7f 发不出去
    // （「删除键删除不了」的根因）。这里手动派发删除控制符 + preventDefault +
    // return false（提前返回可同时跳过 CompositionHelper 的 229 吞键分支）。
    // 浏览器误插兜底：suppressNextInsert + onImeCommitInput 的空白无条件拦截
    // 不依赖 keydown 到达，WKWebView 下 preventDefault 失效也能兜住。
    rawWrite(isBackspace ? "\x7f" : "\x1b[3~");
    if (e.cancelable) {
      e.preventDefault();
    }
    return false;
  });

  cleanups.push(() => syncTuiChrome(term, false));

  return () => {
    for (const fn of cleanups) fn();
  };
}

/** 终端推荐选项：避免过大 lineHeight 导致 CJK/组字层错位 */
export function terminalBaseOptions() {
  return {
    cursorBlink: true,
    fontFamily:
      'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", "Noto Sans Mono CJK SC", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0,
    allowProposedApi: true as const,
    macOptionIsMeta: true,
    // 长时间运行的 dev server 可能持续输出日志；回滚区上限 1000 行，
    // 避免历史全部留在 WebView 内存里，和编辑器/资源树争抢渲染资源。
    scrollback: 1000,
    /** 右键点按选中整词（macOS 终端惯例） */
    rightClickSelectsWord: true,
    /** Shift+滚轮加速滚动回滚区（非 Vim 全屏时） */
    fastScrollModifier: "shift" as const,
  };
}
