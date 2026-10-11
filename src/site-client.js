/*
 * docs-kit selection toolbar and WebMCP tools. Written by `docs-kit build` as
 * docs-kit.js at the site root and loaded by every page. Template output, not
 * document content: it reads provenance from the data-* attributes on <main>
 * and from data-src-line on rendered blocks, and it never puts selected text
 * into the page as HTML (textContent and textarea values only).
 */
(function () {
  'use strict';

  var main = document.querySelector('main[data-src-path]');
  if (!main) return;
  var page = {
    path: main.getAttribute('data-src-path') || '',
    sha: main.getAttribute('data-src-sha') || '',
    repo: main.getAttribute('data-repo') || '',
    product: main.getAttribute('data-product') || '',
    title: main.getAttribute('data-title') || '',
    branch: main.getAttribute('data-branch') || 'main',
    primary: main.getAttribute('data-selection-primary') === 'challenge-issue' ? 'challenge-issue' : 'ask',
  };
  var script = document.currentScript;
  var siteRoot = new URL('./', script && script.src ? script.src : location.href).href;
  var LINE = /^(\d+)-(\d+)$/;
  // GitHub refuses very long URLs (about 8 KB); stay under it with room to spare.
  var ISSUE_URL_MAX = 8000;
  var EXCERPT_MAX = 60;

  function encodePath(value) {
    return value.split('/').map(encodeURIComponent).join('/');
  }

  function pageUrl(anchor) {
    var url = location.href.split('#')[0];
    return anchor ? url + '#' + encodeURIComponent(anchor) : url;
  }

  function headingText(heading) {
    var text = '';
    for (var i = 0; i < heading.childNodes.length; i++) {
      var node = heading.childNodes[i];
      if (node.nodeType === 1 && node.classList.contains('anchor')) continue;
      text += node.textContent;
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  /** True when `range` selects visible text inside `element`. */
  function selectsTextIn(range, element) {
    if (!range.intersectsNode(element)) return false;
    var inner = document.createRange();
    inner.selectNodeContents(element);
    if (range.compareBoundaryPoints(Range.START_TO_START, inner) > 0) inner.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, inner) < 0) inner.setEnd(range.endContainer, range.endOffset);
    return inner.toString().trim() !== '';
  }

  /**
   * The current selection with its provenance, or null when nothing in
   * <main> is selected. Lines span every annotated block the selection
   * touches; the heading is the last one at or before the selection start.
   */
  function selectionContext() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    var text = selection.toString();
    if (!text.trim()) return null;
    var range = selection.getRangeAt(0);
    if (!main.contains(range.commonAncestorContainer)) return null;
    var start = null;
    var end = null;
    var blocks = main.querySelectorAll('[data-src-line]');
    for (var i = 0; i < blocks.length; i++) {
      var match = LINE.exec(blocks[i].getAttribute('data-src-line') || '');
      if (!match || !selectsTextIn(range, blocks[i])) continue;
      var from = Number(match[1]);
      var to = Number(match[2]);
      if (start === null || from < start) start = from;
      if (end === null || to > end) end = to;
    }
    var heading = null;
    var headings = main.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
    for (var j = 0; j < headings.length; j++) {
      var h = headings[j];
      var before = h.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (before || h.contains(range.startContainer)) heading = h;
      else break;
    }
    var anchor = heading ? heading.id : null;
    return {
      product: page.product,
      title: page.title,
      repo: page.repo,
      path: page.path,
      sha: page.sha,
      branch: page.branch,
      startLine: start,
      endLine: end,
      heading: heading ? headingText(heading) : null,
      anchor: anchor,
      url: pageUrl(anchor),
      text: text.trim(),
    };
  }

  function sourceRef(context) {
    var lines = context.startLine === null ? '' : ':' + context.startLine + '-' + context.endLine;
    return context.path + lines + '@' + context.sha;
  }

  function quote(text) {
    return text
      .split(/\r?\n/)
      .map(function (line) {
        return line ? '> ' + line : '>';
      })
      .join('\n');
  }

  function provenance(context) {
    return [
      'Product: ' + context.title + ' (' + context.product + '), repository ' + context.repo,
      'Source: ' + sourceRef(context),
      'Section: ' + (context.heading || '(top of page)'),
      'Page: ' + context.url,
    ].join('\n');
  }

  function locateHint(context) {
    return (
      'First call the kontour-docs MCP `locate` tool with product "' + context.product + '" and this quote to find the exact source, ' +
      'then read the actual source code it describes (at ' + context.sha.slice(0, 12) + ' and on current main) before you answer. ' +
      'Do not answer from the documentation alone.'
    );
  }

  function askPrompt(context) {
    return [
      'I am reading the ' + context.title + ' docs and want to ask about this passage.',
      '',
      provenance(context),
      '',
      quote(context.text),
      '',
      locateHint(context),
      '',
      'Question: ',
    ].join('\n');
  }

  function challengeText(context) {
    return (
      "Is this accurate? Verify the claim against the implementation at " + context.sha + " and current main. " +
      "If it's wrong or unclear, propose a doc fix (or a code fix if the doc describes intended behaviour)."
    );
  }

  function challengePrompt(context) {
    return ['I want to challenge this passage in the ' + context.title + ' docs.', '', provenance(context), '', quote(context.text), '', challengeText(context), '', locateHint(context)].join('\n');
  }

  /**
   * The quote as a fenced code block: an issue body is live Markdown, and a
   * blockquote would turn @names into mentions and #123 into references.
   * The fence is longer than any backtick run in the text.
   */
  function fenced(text) {
    var longest = 2;
    (text.match(/`+/g) || []).forEach(function (run) {
      longest = Math.max(longest, run.length);
    });
    var fence = new Array(longest + 2).join('`');
    return fence + 'text\n' + text + '\n' + fence;
  }

  function issueUrl(context) {
    var title = 'Docs challenge: ' + context.path + (context.startLine === null ? '' : ':' + context.startLine + '-' + context.endLine);
    var build = function (text, minimal) {
      var lines = [challengeText(context), '', fenced(text), '', '- Source: `' + sourceRef(context) + '`'];
      if (!minimal) lines.push('- Section: ' + (context.heading || '(top of page)'), '- Page: ' + context.url);
      return (
        'https://github.com/' + context.repo + '/issues/new?title=' + encodeURIComponent(minimal ? title.slice(0, 200).replace(/[\uD800-\uDBFF]$/, '') : title) +
        '&body=' + encodeURIComponent(lines.join('\n')) + '&labels=docs-challenge'
      );
    };
    var text = context.text;
    var url = build(text, false);
    var keep = text.length;
    // Shrink the quote until the URL fits. One UTF-16 unit encodes to at most
    // nine characters (%E2%80%A6), so cutting overflow/9 never overshoots.
    while (url.length > ISSUE_URL_MAX && keep > 0) {
      keep = Math.max(0, keep - Math.max(1, Math.ceil((url.length - ISSUE_URL_MAX) / 9)));
      // Never leave half a surrogate pair: encodeURIComponent throws on one.
      text = context.text.slice(0, keep).replace(/[\uD800-\uDBFF]$/, '').replace(/\s+$/, '') + '\u2026';
      url = build(text, false);
    }
    // Still too long without any quote (an enormous heading or page URL): drop them.
    if (url.length > ISSUE_URL_MAX) url = build('\u2026', true);
    return url;
  }

  function editUrl(context) {
    var hash = context.startLine === null ? '' : '#L' + context.startLine;
    return 'https://github.com/' + context.repo + '/edit/' + encodePath(context.branch) + '/' + encodePath(context.path) + hash;
  }

  function excerpt(text) {
    var flat = text.replace(/\s+/g, ' ');
    return flat.length > EXCERPT_MAX ? flat.slice(0, EXCERPT_MAX - 1) + '…' : flat;
  }

  // ---- UI -------------------------------------------------------------

  var toast = document.createElement('div');
  toast.className = 'dk-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.setAttribute('aria-atomic', 'true');
  var toastTimer = null;

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('dk-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove('dk-visible');
    }, 3200);
  }

  var dialog = null;
  function showPromptDialog(label, prompt) {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'dk-dialog';
      dialog.setAttribute('aria-labelledby', 'dk-dialog-title');
      var heading = document.createElement('h2');
      heading.id = 'dk-dialog-title';
      var help = document.createElement('p');
      help.textContent = 'Clipboard access is not available here. Select the text below and copy it, then paste it into your agent.';
      var area = document.createElement('textarea');
      area.readOnly = true;
      area.setAttribute('aria-label', 'Prompt');
      var actions = document.createElement('div');
      actions.className = 'dk-actions';
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'dk-primary';
      close.textContent = 'Close';
      close.addEventListener('click', function () {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      });
      actions.appendChild(close);
      dialog.appendChild(heading);
      dialog.appendChild(help);
      dialog.appendChild(area);
      dialog.appendChild(actions);
      document.body.appendChild(dialog);
    }
    dialog.querySelector('h2').textContent = label;
    var textarea = dialog.querySelector('textarea');
    textarea.value = prompt;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else dialog.setAttribute('open', '');
    textarea.focus();
    textarea.select();
  }

  function copy(label, prompt, context) {
    var done = function () {
      showToast('Copied ' + label.toLowerCase() + ' for “' + excerpt(context.text) + '”. Paste it into your agent.');
    };
    var fallback = function () {
      showPromptDialog(label, prompt);
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(prompt).then(done, fallback);
        return;
      }
    } catch (error) {
      // fall through to the dialog
    }
    fallback();
  }

  function open(url) {
    window.open(url, '_blank', 'noopener');
  }

  var ACTIONS = {
    ask: { label: 'Ask', shortcut: 'Alt+A', title: 'Copy a prompt that asks your agent about this passage', run: function (c) { copy('Ask prompt', askPrompt(c), c); } },
    challenge: { label: 'Challenge', shortcut: 'Alt+C', title: 'Copy a prompt that asks your agent to verify this passage', run: function (c) { copy('Challenge prompt', challengePrompt(c), c); } },
    'challenge-issue': { label: 'Open issue', title: 'Open a prefilled GitHub issue challenging this passage', run: function (c) { open(issueUrl(c)); } },
    edit: { label: 'Edit', title: 'Edit the source of this passage on GitHub', run: function (c) { open(editUrl(c)); } },
  };
  var order = page.primary === 'challenge-issue' ? ['challenge-issue', 'challenge', 'ask', 'edit'] : ['ask', 'challenge', 'challenge-issue', 'edit'];

  var toolbar = document.createElement('div');
  toolbar.className = 'dk-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Selected text actions');
  toolbar.hidden = true;
  var current = null;
  // A tap on a touch screen can clear the selection before its click arrives,
  // so the last shown context stays usable while the toolbar is being pressed.
  var recent = null;
  var pressing = false;
  order.forEach(function (name, index) {
    var action = ACTIONS[name];
    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-action', name);
    button.title = action.title;
    button.textContent = action.label;
    button.setAttribute('aria-label', action.label);
    if (index === 0) button.className = 'dk-primary';
    if (action.shortcut) {
      button.setAttribute('aria-keyshortcuts', action.shortcut);
      var kbd = document.createElement('kbd');
      kbd.textContent = action.shortcut;
      button.appendChild(kbd);
    }
    button.tabIndex = index === 0 ? 0 : -1;
    button.addEventListener('click', function () {
      // The live selection wins: the toolbar's context can be up to one debounce old.
      var context = selectionContext() || current || recent;
      pressing = false;
      if (context) action.run(context);
    });
    toolbar.appendChild(button);
  });
  // Keep the selection when a toolbar button is pressed with a mouse.
  toolbar.addEventListener('mousedown', function (event) {
    event.preventDefault();
  });
  toolbar.addEventListener('pointerdown', function () {
    pressing = true;
  });
  toolbar.addEventListener('pointercancel', function () {
    pressing = false;
  });
  window.addEventListener('pointerup', function () {
    if (pressing)
      setTimeout(function () {
        pressing = false;
      }, 400);
  });
  toolbar.addEventListener('keydown', function (event) {
    var buttons = toolbar.querySelectorAll('button');
    var index = Array.prototype.indexOf.call(buttons, document.activeElement);
    var next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      hide();
      main.focus({ preventScroll: true });
      return;
    }
    if (next === null) return;
    event.preventDefault();
    for (var i = 0; i < buttons.length; i++) buttons[i].tabIndex = i === next ? 0 : -1;
    buttons[next].focus();
  });

  var coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : { matches: false };
  var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function place() {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    var rects = selection.getRangeAt(0).getClientRects();
    var rect = rects.length ? rects[coarse.matches ? rects.length - 1 : 0] : selection.getRangeAt(0).getBoundingClientRect();
    var width = toolbar.offsetWidth;
    var height = toolbar.offsetHeight;
    var gap = 8;
    // Touch browsers draw their own selection menu above the selection, so go below it there.
    var top = coarse.matches || rect.top - height - gap < 0 ? rect.bottom + gap : rect.top - height - gap;
    var left = Math.min(Math.max(gap, rect.left), document.documentElement.clientWidth - width - gap);
    toolbar.style.top = Math.round(top + window.scrollY) + 'px';
    toolbar.style.left = Math.round(Math.max(gap, left) + window.scrollX) + 'px';
  }

  function show(context) {
    current = context;
    recent = context;
    var wasHidden = toolbar.hidden;
    toolbar.hidden = false;
    place();
    if (wasHidden && !reduced.matches) {
      toolbar.classList.add('dk-entering');
      requestAnimationFrame(function () {
        toolbar.classList.remove('dk-entering');
      });
    }
  }

  function hide() {
    toolbar.hidden = true;
    current = null;
  }

  var pending = null;
  document.addEventListener('selectionchange', function () {
    clearTimeout(pending);
    pending = setTimeout(function () {
      if (pressing || toolbar.contains(document.activeElement)) return;
      var context = selectionContext();
      if (context) show(context);
      else hide();
    }, 80);
  });

  document.addEventListener('keydown', function (event) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    var name = event.code === 'KeyA' ? 'ask' : event.code === 'KeyC' ? 'challenge' : event.code === 'KeyT' ? 'focus' : null;
    if (!name) return;
    var context = selectionContext() || current;
    if (!context) return;
    event.preventDefault();
    if (name === 'focus') {
      show(context);
      var first = toolbar.querySelector('button[tabindex="0"]') || toolbar.querySelector('button');
      first.focus();
      return;
    }
    ACTIONS[name].run(context);
  });

  window.addEventListener('resize', function () {
    if (!toolbar.hidden) place();
  });

  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  document.body.appendChild(toolbar);
  document.body.appendChild(toast);

  // ---- WebMCP (progressive; Chromium-only draft API) -------------------

  var bundlePromise = null;
  function loadBundle(signal) {
    if (!bundlePromise) {
      bundlePromise = fetch(new URL('docs-bundle.json', siteRoot).href, { signal: signal, credentials: 'same-origin' }).then(function (response) {
        if (!response.ok) throw new Error('docs-bundle.json: HTTP ' + response.status);
        return response.json();
      });
      bundlePromise.catch(function () {
        bundlePromise = null;
      });
    }
    return bundlePromise;
  }

  function words(text) {
    var seen = {};
    return String(text)
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(function (word) {
        if (!word || seen[word]) return false;
        seen[word] = true;
        return true;
      });
  }

  function count(haystack, needle) {
    var total = 0;
    for (var at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) total++;
    return total;
  }

  function searchBundle(bundle, query, limit) {
    var terms = words(query);
    var items = bundle.topics
      .map(function (topic) {
        return { kind: 'topic', id: topic.id, title: topic.title, source: topic.source, url: topic.url, meta: topic.id + ' ' + topic.source, markdown: topic.markdown };
      })
      .concat(
        bundle.documents.map(function (document) {
          return { kind: 'document', title: document.title, source: document.source, url: document.url, meta: document.source, markdown: document.markdown };
        }),
      );
    var results = [];
    items.forEach(function (item) {
      var title = item.title.toLowerCase();
      var meta = item.meta.toLowerCase();
      var body = item.markdown.toLowerCase();
      var score = 0;
      var matched = 0;
      terms.forEach(function (term) {
        var termScore = count(title, term) * 5 + count(meta, term) * 3 + Math.min(count(body, term), 10);
        if (termScore > 0) matched++;
        score += termScore;
      });
      if (!matched) return;
      var at = Math.max(0, body.indexOf(terms[0]) - 80);
      results.push({
        kind: item.kind,
        id: item.id,
        title: item.title,
        source: item.source,
        url: item.url,
        score: Math.round(score * (matched / terms.length) * 100) / 100,
        snippet: item.markdown.slice(at, at + 220).replace(/\s+/g, ' ').trim(),
      });
    });
    results.sort(function (a, b) {
      return b.score - a.score || (a.kind === b.kind ? 0 : a.kind === 'topic' ? -1 : 1);
    });
    return results.slice(0, limit);
  }

  function registerWebMcp() {
    var mc;
    try {
      mc = document.modelContext || navigator.modelContext;
    } catch (error) {
      return;
    }
    if (!mc || typeof mc.registerTool !== 'function') return;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var handles = [];
    // The current draft resolves registerTool with a Promise and serializes any
    // return value to JSON; the older synchronous API expected MCP-style content.
    var legacy = false;
    var reply = function (data) {
      return legacy ? { content: [{ type: 'text', text: JSON.stringify(data) }] } : data;
    };
    var safely = function (run) {
      return function (input, options) {
        return Promise.resolve()
          .then(function () {
            return run(input || {}, (options && options.signal) || undefined);
          })
          .then(reply, function (error) {
            return reply({ error: String((error && error.message) || error) });
          });
      };
    };
    var base = { product: page.product, repo: page.repo, sha: page.sha };
    var tools = [
      {
        name: 'get_selection_context',
        title: 'Selected docs text',
        description: 'The text the user has selected on this ' + page.title + ' docs page, with its source provenance: repository, file path, 1-based line range, commit sha, enclosing heading and anchor, and page URL.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        execute: safely(function () {
          var context = selectionContext() || current;
          return context ? { selection: context } : { selection: null, page: { product: page.product, repo: page.repo, path: page.path, sha: page.sha, url: pageUrl(null) }, reason: 'no text is selected in the page content' };
        }),
      },
      {
        name: 'search_docs',
        title: 'Search these docs',
        description: 'Keyword search over the ' + page.title + ' documentation bundle (topics and documents) served by this site.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Words to look for.' }, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results (default 10).' } },
          required: ['query'],
        },
        annotations: { readOnlyHint: true },
        execute: safely(function (input, signal) {
          if (!words(input.query || '').length) return { error: 'query must contain at least one word' };
          var limit = Math.min(50, Math.max(1, Math.floor(Number(input.limit) || 10)));
          return loadBundle(signal).then(function (bundle) {
            return Object.assign({ query: input.query, results: searchBundle(bundle, input.query, limit) }, base, { sha: bundle.sha });
          });
        }),
      },
      {
        name: 'get_topic',
        title: 'Read a docs topic',
        description: 'Read one curated ' + page.title + ' documentation topic as Markdown, by id. search_docs returns topic ids.',
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Topic id.' } }, required: ['id'] },
        annotations: { readOnlyHint: true },
        execute: safely(function (input, signal) {
          return loadBundle(signal).then(function (bundle) {
            var topic = bundle.topics.filter(function (entry) {
              return entry.id === input.id;
            })[0];
            if (!topic) return { error: 'unknown topic "' + input.id + '"', availableTopics: bundle.topics.map(function (entry) { return entry.id; }) };
            return Object.assign({}, base, { sha: bundle.sha, topic: topic });
          });
        }),
      },
    ];
    tools.forEach(function (tool) {
      try {
        var result = controller ? mc.registerTool(tool, { signal: controller.signal }) : mc.registerTool(tool);
        if (result && typeof result.then === 'function') result.then(null, function () {});
        else {
          legacy = true;
          if (result && typeof result.unregister === 'function') handles.push(result);
        }
      } catch (error) {
        // An unsupported or changed API must never break the page.
      }
    });
    window.addEventListener('pagehide', function (event) {
      if (event.persisted) return;
      try {
        if (controller) controller.abort();
        handles.forEach(function (handle) {
          handle.unregister();
        });
      } catch (error) {
        // ignore
      }
    });
  }

  try {
    registerWebMcp();
  } catch (error) {
    // WebMCP is optional.
  }
})();
