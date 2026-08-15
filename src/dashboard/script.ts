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
    decisions: {}
  };

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
    state.decisions[id] = verdict;

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

    var card = document.querySelector('[data-match-id="' + id + '"]');
    if (card) {
      card.setAttribute("data-leaving", "true");
      window.setTimeout(function () {
        if (card.parentNode) card.parentNode.removeChild(card);
        renderQueueEmptyState();
      }, 200);
    }

    renderCounts();
    renderBridge();
    renderLeftovers();
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

  renderCounts();
  renderBridge();
  renderLeftovers();
  renderPostings();
  renderQueueEmptyState();
})();
`;
