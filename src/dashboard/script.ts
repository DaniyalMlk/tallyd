/**
 * The client script, inlined.
 *
 * It does one thing that matters: accepting or rejecting a suggestion changes
 * the reconciliation and the bridge recomputes in front of you. A dashboard
 * that renders the same static figures the CLI already prints is a worse CLI —
 * the reason to have a screen is that a decision can have an effect.
 *
 * The arithmetic runs entirely in integer minor units. JavaScript numbers are
 * exact for integers well past any sum a small company's bank account will
 * reach, and the one thing this page must never do is show a reconciliation
 * that is out by a penny because a float rounded.
 *
 * ## What leaves the page
 *
 * Decisions are exported as the decisions document, which `tallyd learn` reads.
 * The payload for each suggestion was built in TypeScript and baked into
 * `window.__TALLYD__`; this script stamps a verdict and today's date onto it
 * and serialises the result. Nothing here knows the shape of the format beyond
 * those two fields, which is the point — a format definition living in a
 * string of hand-written client JavaScript is a format definition nobody can
 * test.
 *
 * A decision is reversible until it is exported. A queue card is hidden rather
 * than destroyed when it is decided, so undo is a matter of putting it back
 * where it was rather than rebuilding it from data.
 */

export const CLIENT_SCRIPT = String.raw`
(function () {
  "use strict";

  var data = window.__TALLYD__;
  if (!data) return;

  var state = {
    matched: data.matched.slice(),
    suggested: data.suggested.slice(),
    unmatchedBook: data.unmatchedBook.slice(),
    unmatchedStatement: data.unmatchedStatement.slice(),
    // Decided suggestions, oldest first. Undo pops from the end.
    decided: []
  };

  // Where each suggestion sat in the queue to begin with, so an undo puts it
  // back among its neighbours rather than at the bottom.
  var queueOrder = {};
  for (var q = 0; q < data.suggested.length; q++) queueOrder[data.suggested[q].id] = q;

  /** Today, in the reviewer's own calendar rather than UTC's. */
  function today() {
    var now = new Date();
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  }

  // ------------------------------------------------------------ formatting

  function money(minor) {
    var negative = minor < 0;
    var digits = String(Math.abs(minor));
    while (digits.length < data.exponent + 1) digits = "0" + digits;
    var whole = digits.slice(0, digits.length - data.exponent);
    var fraction = data.exponent === 0 ? "" : "." + digits.slice(digits.length - data.exponent);
    whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (negative ? "-" : "") + data.currencySymbol + whole + fraction;
  }

  function sumMinor(lines) {
    var total = 0;
    for (var i = 0; i < lines.length; i++) total += lines[i].amount.minor;
    return total;
  }

  // ---------------------------------------------------------------- bridge

  /**
   * Bank closing plus everything in our books the bank has not seen, against
   * ledger closing plus everything on the statement we have not booked. An
   * undecided suggestion counts as outstanding on both sides: until someone
   * confirms it, it is not evidence.
   */
  function bridge() {
    var outstandingBook = state.unmatchedBook.slice();
    var outstandingStatement = state.unmatchedStatement.slice();

    for (var i = 0; i < state.suggested.length; i++) {
      outstandingBook = outstandingBook.concat(state.suggested[i].book);
      outstandingStatement = outstandingStatement.concat(state.suggested[i].statement);
    }

    var bookOutstanding = sumMinor(outstandingBook);
    var statementOutstanding = sumMinor(outstandingStatement);

    var adjustedBank = data.bankClosingMinor + bookOutstanding;
    var adjustedBook = data.bookClosingMinor + statementOutstanding;

    return {
      depositsInTransit: outstandingBook.filter(function (line) { return line.amount.minor > 0; }),
      unpresented: outstandingBook.filter(function (line) { return line.amount.minor <= 0; }),
      bankCredits: outstandingStatement.filter(function (line) { return line.amount.minor > 0; }),
      bankDebits: outstandingStatement.filter(function (line) { return line.amount.minor <= 0; }),
      adjustedBank: adjustedBank,
      adjustedBook: adjustedBook,
      difference: adjustedBank - adjustedBook
    };
  }

  // ------------------------------------------------------------- rendering

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scheduleRow(list, label, lines) {
    if (lines.length === 0) return;
    var heading = element("dt", null, label);
    var total = element("dd", null, money(sumMinor(lines)));
    list.appendChild(heading);
    list.appendChild(total);
  }

  function renderBridge() {
    var result = bridge();
    var list = document.getElementById("bridge-list");
    list.textContent = "";

    function row(label, value, lead) {
      var dt = element("dt", lead ? "lead-row" : null, label);
      var dd = element("dd", lead ? "lead-row" : null, money(value));
      list.appendChild(dt);
      list.appendChild(dd);
    }

    function divider() {
      list.appendChild(element("div", "rule-row"));
    }

    row("Balance per bank statement", data.bankClosingMinor);
    scheduleRow(list, "Add: receipts not yet on the statement", result.depositsInTransit);
    scheduleRow(list, "Less: payments not yet on the statement", result.unpresented);
    divider();
    row("Adjusted bank balance", result.adjustedBank, true);

    divider();

    row("Balance per the ledger", data.bookClosingMinor);
    scheduleRow(list, "Add: bank credits not yet booked", result.bankCredits);
    scheduleRow(list, "Less: bank debits not yet booked", result.bankDebits);
    divider();
    row("Adjusted ledger balance", result.adjustedBook, true);

    var verdict = document.getElementById("bridge-verdict");
    var balanced = result.difference === 0;
    verdict.setAttribute("data-state", balanced ? "balanced" : "off");
    verdict.querySelector(".label").textContent = balanced
      ? "Reconciled"
      : "The two sides do not agree";
    verdict.querySelector(".figure").textContent = money(result.difference);
  }

  function renderCounts() {
    document.getElementById("count-matched").textContent = String(state.matched.length);
    document.getElementById("count-review").textContent = String(state.suggested.length);
    document.getElementById("count-book").textContent = String(state.unmatchedBook.length);
    document.getElementById("count-bank").textContent = String(state.unmatchedStatement.length);

    var queueTally = document.getElementById("queue-tally");
    if (queueTally) {
      queueTally.textContent =
        state.suggested.length === 0
          ? "clear"
          : state.suggested.length + (state.suggested.length === 1 ? " item" : " items");
    }
    var matchedTally = document.getElementById("matched-tally");
    if (matchedTally) matchedTally.textContent = String(state.matched.length);
  }

  function renderLeftovers() {
    renderLineTable("leftover-book", state.unmatchedBook, "Everything in the books is on the statement.");
    renderLineTable(
      "leftover-bank",
      state.unmatchedStatement,
      "Every statement line is accounted for."
    );
  }

  function renderLineTable(id, lines, emptyMessage) {
    var host = document.getElementById(id);
    if (!host) return;
    host.textContent = "";

    if (lines.length === 0) {
      var empty = element("div", "empty");
      empty.appendChild(element("strong", null, "Nothing left"));
      empty.appendChild(document.createTextNode(emptyMessage));
      host.appendChild(empty);
      return;
    }

    var table = document.createElement("table");
    var head = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["Date", "Description", "Amount"].forEach(function (label, index) {
      var cell = element("th", index === 2 ? "num" : null, label);
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = document.createElement("tbody");
    lines.forEach(function (line) {
      var row = document.createElement("tr");
      row.appendChild(element("td", "when", line.date));
      row.appendChild(element("td", null, line.description));
      var amount = element("td", "num" + (line.amount.minor < 0 ? " negative" : ""), line.amount.text);
      row.appendChild(amount);
      body.appendChild(row);
    });
    table.appendChild(body);
    host.appendChild(table);
  }

  function announce(message) {
    var live = document.getElementById("live-region");
    if (live) live.textContent = message;
  }

  // --------------------------------------------------------------- actions

  function findSuggestion(id) {
    for (var i = 0; i < state.suggested.length; i++) {
      if (state.suggested[i].id === id) return { match: state.suggested[i], index: i };
    }
    return null;
  }

  function decide(id, verdict) {
    var found = findSuggestion(id);
    if (!found) return;

    state.suggested.splice(found.index, 1);
    state.decided.push({ id: id, verdict: verdict, match: found.match });

    if (verdict === "accepted") {
      state.matched = state.matched.concat([found.match]);
      announce("Match accepted: " + found.match.amount.text + ". " + state.suggested.length + " left to review.");
    } else {
      state.unmatchedBook = state.unmatchedBook.concat(found.match.book);
      state.unmatchedStatement = state.unmatchedStatement.concat(found.match.statement);
      state.unmatchedBook.sort(byDate);
      state.unmatchedStatement.sort(byDate);
      announce("Match rejected. Both lines returned to the leftovers.");
    }

    var card = queueCard(id);
    if (card) {
      card.setAttribute("data-leaving", "true");
      window.setTimeout(function () {
        if (card.getAttribute("data-leaving") === "true") card.hidden = true;
        renderQueueEmptyState();
      }, 200);
    }

    refresh();
  }

  /** Put a decision back, card and all, as if it had never been made. */
  function undo(id) {
    var index = -1;
    for (var i = 0; i < state.decided.length; i++) {
      if (state.decided[i].id === id) { index = i; break; }
    }
    if (index === -1) return;

    var entry = state.decided.splice(index, 1)[0];
    var match = entry.match;

    if (entry.verdict === "accepted") {
      state.matched = state.matched.filter(function (m) { return m.id !== id; });
    } else {
      state.unmatchedBook = withoutLines(state.unmatchedBook, match.book);
      state.unmatchedStatement = withoutLines(state.unmatchedStatement, match.statement);
    }

    // Back among its neighbours: before the first suggestion that started
    // life after it did.
    var at = state.suggested.length;
    for (var j = 0; j < state.suggested.length; j++) {
      if (queueOrder[state.suggested[j].id] > queueOrder[id]) { at = j; break; }
    }
    state.suggested.splice(at, 0, match);

    var card = queueCard(id);
    if (card) {
      card.hidden = false;
      card.removeAttribute("data-leaving");
    }
    var placeholder = document.querySelector("#queue .empty");
    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);

    announce("Decision undone. " + state.suggested.length + " to review.");
    refresh();
  }

  function withoutLines(lines, remove) {
    var ids = {};
    for (var i = 0; i < remove.length; i++) ids[remove[i].id] = true;
    return lines.filter(function (line) { return !ids[line.id]; });
  }

  function queueCard(id) {
    return document.querySelector('#queue [data-match-id="' + id + '"]');
  }

  // ------------------------------------------------------------- decisions

  /**
   * The decisions document, in the format "tallyd learn" reads.
   *
   * Every payload the server computed for a decided suggestion, with the
   * verdict and the date stamped on. A group match contributes several
   * records from one click; that expansion happened in TypeScript.
   */
  function decisionsDocument() {
    var on = today();
    var records = [];
    for (var i = 0; i < state.decided.length; i++) {
      var entry = state.decided[i];
      var payloads = entry.match.decision || [];
      for (var j = 0; j < payloads.length; j++) {
        records.push({
          statement: payloads[j].statement,
          book: payloads[j].book,
          accepted: entry.verdict === "accepted",
          on: on,
          context: payloads[j].context
        });
      }
    }
    return records;
  }

  function decisionsJson() {
    return JSON.stringify(decisionsDocument(), null, 2) + "\n";
  }

  function exportDecisions() {
    var text = decisionsJson();
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "decisions-" + data.account + "-" + today() + ".json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    announce("Decisions file written.");
  }

  /**
   * Copy, for the browser that will not download from a file:// document.
   * The clipboard API needs a secure context and this page is often opened
   * off a disk, so the textarea route is the one that actually runs.
   */
  function copyDecisions(button) {
    var text = decisionsJson();
    var done = function (ok) {
      var label = button.textContent;
      button.textContent = ok ? "Copied" : "Press ⌘C";
      window.setTimeout(function () { button.textContent = label; }, 1400);
      announce(ok ? "Decisions copied to the clipboard." : "Select the text and copy it.");
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { legacyCopy(text, done); });
      return;
    }
    legacyCopy(text, done);
  }

  function legacyCopy(text, done) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (error) { ok = false; }
    document.body.removeChild(area);
    done(ok);
  }

  function renderDecided() {
    var section = document.getElementById("decided-section");
    var host = document.getElementById("decided-list");
    var bar = document.getElementById("decision-bar");
    var tally = document.getElementById("decision-tally");
    if (!section || !host || !bar || !tally) return;

    var count = state.decided.length;
    section.hidden = count === 0;
    bar.setAttribute("data-open", count === 0 ? "false" : "true");

    var facts = decisionsDocument().length;
    tally.innerHTML = "";
    tally.appendChild(element("strong", null, String(count)));
    tally.appendChild(
      document.createTextNode(
        (count === 1 ? " decision" : " decisions") +
          ", " + facts + (facts === 1 ? " counterparty fact" : " counterparty facts") +
          " to export"
      )
    );

    host.textContent = "";
    // Newest first: the thing most likely to be undone is the thing just done.
    for (var i = state.decided.length - 1; i >= 0; i--) {
      var entry = state.decided[i];
      var row = element("div", "decided-row");

      var verdict = element("span", "verdict", entry.verdict);
      verdict.setAttribute("data-verdict", entry.verdict);
      row.appendChild(verdict);

      var bank = entry.match.statement[0] || entry.match.book[0];
      row.appendChild(element("span", "when", bank ? bank.date : ""));
      row.appendChild(element("span", "what", bank ? bank.description : "—"));
      row.appendChild(
        element(
          "span",
          "how-much" + (entry.match.amount.minor < 0 ? " negative" : ""),
          entry.match.amount.text
        )
      );

      var button = element("button", null, "Undo");
      button.setAttribute("type", "button");
      button.setAttribute("data-action", "undo");
      button.setAttribute("data-match-id", entry.id);
      row.appendChild(button);

      host.appendChild(row);
    }

    var undoLast = document.querySelector('[data-action="undo-last"]');
    if (undoLast) undoLast.disabled = count === 0;
  }

  // --------------------------------------------------------------- implied

  var impliedByLine = {};
  for (var e = 0; e < (data.implied || []).length; e++) {
    impliedByLine[data.implied[e].lineId] = data.implied[e];
  }

  /**
   * The entries the current state of the review implies.
   *
   * Every statement line has a proposal precomputed; which ones are live
   * follows from the leftovers, so rejecting a suggestion adds a row here in
   * the same gesture that pushes its lines back into the leftovers.
   */
  function renderImplied() {
    var section = document.getElementById("implied-section");
    var host = document.getElementById("implied");
    if (!section || !host) return;

    var rows = [];
    for (var i = 0; i < state.unmatchedStatement.length; i++) {
      var proposal = impliedByLine[state.unmatchedStatement[i].id];
      if (proposal) rows.push(proposal);
    }
    rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

    host.textContent = "";

    if (rows.length === 0) {
      var empty = element("div", "empty");
      empty.appendChild(element("strong", null, "Nothing to book"));
      empty.appendChild(
        document.createTextNode("Every statement line has a counterpart in the books.")
      );
      host.appendChild(empty);
      return;
    }

    var booked = 0;
    var total = 0;

    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      var node = element("div", "implied-row");
      node.setAttribute("data-outcome", row.outcome);

      node.appendChild(element("span", "when", row.date));
      node.appendChild(element("span", "what", row.description));
      node.appendChild(
        element("span", "how-much" + (row.amount.minor < 0 ? " negative" : ""), row.amount.text)
      );

      var lands = element("span", "lands");
      if (row.outcome === "book" && row.account) {
        var code = element("code", null, row.account);
        lands.appendChild(code);
        lands.appendChild(document.createTextNode(" " + (row.accountName || "")));
        booked += 1;
        total += row.amount.minor;
      } else if (row.outcome === "skip") {
        lands.textContent = "not a transaction";
      } else if (row.outcome === "already-booked") {
        lands.textContent = "already booked";
      } else {
        lands.textContent = "no rule";
      }
      lands.title = row.reason;
      node.appendChild(lands);

      host.appendChild(node);
    }

    var summary = element("div", "implied-total");
    summary.appendChild(
      element(
        "span",
        null,
        booked + (booked === 1 ? " entry to book" : " entries to book") +
          ", " + (rows.length - booked) + " left for a person"
      )
    );
    summary.appendChild(element("span", "figure", money(total)));
    host.appendChild(summary);
  }

  function refresh() {
    renderCounts();
    renderBridge();
    renderLeftovers();
    renderDecided();
    renderImplied();
  }

  function byDate(a, b) {
    if (a.date === b.date) return a.id < b.id ? -1 : 1;
    return a.date < b.date ? -1 : 1;
  }

  function renderQueueEmptyState() {
    var queue = document.getElementById("queue");
    if (!queue) return;
    var existing = queue.querySelector(".empty");
    if (state.suggested.length === 0 && !existing) {
      var empty = element("div", "empty");
      empty.appendChild(element("strong", null, "Queue clear"));
      empty.appendChild(
        document.createTextNode("Every suggestion has been decided. The bridge above is final.")
      );
      queue.appendChild(empty);
    }
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("[data-action]") : null;
    if (!button) return;
    var action = button.getAttribute("data-action");
    var id = button.getAttribute("data-match-id");
    if (action === "accept") decide(id, "accepted");
    if (action === "reject") decide(id, "rejected");
    if (action === "undo") undo(id);
    if (action === "undo-last" && state.decided.length > 0) {
      undo(state.decided[state.decided.length - 1].id);
    }
    if (action === "export-decisions") exportDecisions();
    if (action === "copy-decisions") copyDecisions(button);
  });

  // ------------------------------------------------------- ledger explorer

  var selectedAccount = null;

  function renderPostings() {
    var host = document.getElementById("postings");
    if (!host) return;
    host.textContent = "";

    if (!selectedAccount) {
      var hint = element("div", "empty");
      hint.appendChild(element("strong", null, "Pick an account"));
      hint.appendChild(document.createTextNode("Its postings appear here, oldest first."));
      host.appendChild(hint);
      return;
    }

    var rows = data.postings.filter(function (posting) {
      return posting.account === selectedAccount;
    });

    if (rows.length === 0) {
      var empty = element("div", "empty");
      empty.appendChild(element("strong", null, "No postings"));
      empty.appendChild(document.createTextNode("This account groups others but is never posted to."));
      host.appendChild(empty);
      return;
    }

    var table = document.createElement("table");
    var head = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["Date", "Entry", "Narration", "Contra", "Amount"].forEach(function (label, index) {
      headRow.appendChild(element("th", index === 4 ? "num" : null, label));
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = document.createElement("tbody");
    var running = 0;
    rows.forEach(function (posting) {
      running += posting.amount.minor;
      var row = document.createElement("tr");
      row.appendChild(element("td", "when", posting.date));
      row.appendChild(element("td", "when", posting.entryId));
      row.appendChild(element("td", null, posting.narration));
      row.appendChild(element("td", "when", posting.contra.join(" ")));
      row.appendChild(
        element("td", "num" + (posting.amount.minor < 0 ? " negative" : ""), posting.amount.text)
      );
      body.appendChild(row);
    });
    table.appendChild(body);
    host.appendChild(table);
  }

  document.addEventListener("click", function (event) {
    var row = event.target.closest ? event.target.closest("[data-account]") : null;
    if (!row) return;
    selectAccount(row.getAttribute("data-account"));
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var row = event.target.closest ? event.target.closest("[data-account]") : null;
    if (!row) return;
    event.preventDefault();
    selectAccount(row.getAttribute("data-account"));
  });

  function selectAccount(code) {
    selectedAccount = code;
    var rows = document.querySelectorAll("[data-account]");
    for (var i = 0; i < rows.length; i++) {
      rows[i].setAttribute("aria-selected", rows[i].getAttribute("data-account") === code ? "true" : "false");
    }
    renderPostings();
  }

  // ---------------------------------------------------------- chart hover

  var cash = document.querySelector('[data-chart="cash"]');
  if (cash) {
    var tooltip = cash.querySelector(".tooltip");
    var crosshair = cash.querySelector(".crosshair");
    var svg = cash.querySelector("svg");

    cash.addEventListener("mousemove", function (event) {
      var hit = event.target.closest ? event.target.closest(".hit") : null;
      if (!hit) return;
      var box = svg.getBoundingClientRect();
      var viewBox = svg.viewBox.baseVal;
      var scale = box.width / viewBox.width;

      var pointX = parseFloat(hit.getAttribute("data-x"));
      var pointY = parseFloat(hit.getAttribute("data-y"));

      tooltip.textContent = hit.getAttribute("data-label");
      tooltip.style.left = pointX * scale + "px";
      tooltip.style.top = pointY * scale + "px";
      tooltip.setAttribute("data-visible", "true");

      crosshair.setAttribute("x1", String(pointX));
      crosshair.setAttribute("x2", String(pointX));
      crosshair.style.display = "";
    });

    cash.addEventListener("mouseleave", function () {
      tooltip.setAttribute("data-visible", "false");
      crosshair.style.display = "none";
    });
  }

  // ------------------------------------------------------------------ boot

  refresh();
  renderPostings();
  renderQueueEmptyState();

  // A test harness, and the only supported way in: the page owns its state.
  window.__TALLYD_DECISIONS__ = decisionsDocument;
})();
`;
