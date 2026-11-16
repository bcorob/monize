import {
  HTML_LINES_MAX_INPUT_CHARS,
  HTML_SCAN_MAX_DEPTH,
  JSON_LD_MAX_SCRIPT_CHARS,
  JSON_LD_MAX_SCRIPTS,
  MICRODATA_MAX_DEPTH,
  MICRODATA_MAX_ITEMS,
  collectStructuredData,
  htmlToReceiptLines,
  scanReceiptHtml,
} from "./html-lines.util";
import {
  MAX_LINE_LENGTH,
  MAX_PARSE_LINES,
} from "../parsing/receipt-parser.types";

describe("htmlToReceiptLines: block elements and table cells end a line", () => {
  it("puts each block element on its own line and joins inline text with single spaces", () => {
    const html =
      "<div>Hello <b>big</b>   <i>world</i></div><p>Second\n paragraph</p>trailing";
    expect(htmlToReceiptLines(html)).toEqual([
      "Hello big world",
      "Second paragraph",
      "trailing",
    ]);
  });

  it("ends a line on every block tag of the list, opening and closing", () => {
    for (const tag of [
      "p",
      "div",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "section",
      "article",
      "header",
      "footer",
      "blockquote",
    ]) {
      expect(htmlToReceiptLines(`a<${tag}>b</${tag}>c`)).toEqual([
        "a",
        "b",
        "c",
      ]);
    }
  });

  it("treats br, hr, tr and table as breaks", () => {
    expect(htmlToReceiptLines("a<br>b<br/>c<hr>d")).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(htmlToReceiptLines("x<table><tr><td>a</td></tr></table>y")).toEqual([
      "x",
      "a",
      "y",
    ]);
  });

  it("breaks around nested blocks without losing the text on either side", () => {
    expect(htmlToReceiptLines("<div>a<div>b</div>c</div>")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not add a space between adjacent inline elements", () => {
    expect(htmlToReceiptLines("<b>Total</b><span>12,00</span>")).toEqual([
      "Total12,00",
    ]);
  });

  it("makes every table cell a line, so a row reads as one line per cell", () => {
    const html =
      "<table><tr><td>Product</td><td>Qty</td><td>Price</td></tr>" +
      "<tr><th>Total</th><td>12,00 zł</td></tr></table>";
    expect(htmlToReceiptLines(html)).toEqual([
      "Product",
      "Qty",
      "Price",
      "Total",
      "12,00 zł",
    ]);
  });

  it("reads nested tables, each cell on its own line, in document order", () => {
    const html = `
      <table><tr><td>
        <table><tr><td>Order #A-1</td></tr>
          <tr><td><table><tr><td>Widget</td><td>2 x</td><td>19,98</td></tr></table></td></tr>
        </table>
      </td><td>Side note</td></tr></table>`;
    expect(htmlToReceiptLines(html)).toEqual([
      "Order #A-1",
      "Widget",
      "2 x",
      "19,98",
      "Side note",
    ]);
  });

  it("keeps a product name that a text conversion would wrap in one line", () => {
    const name =
      "Przedłużacz sieciowy z wyłącznikiem, 5 gniazd, kabel 3 m, biały, uziemiony, z ochroną dziecięcą i zabezpieczeniem przeciwprzepięciowym";
    const html = `<table><tr><td>${name}</td><td>1</td><td>49,99 zł</td></tr></table>`;
    expect(htmlToReceiptLines(html)).toEqual([name, "1", "49,99 zł"]);
  });

  it("closes an open cell when the next row starts (omitted end tags)", () => {
    expect(
      htmlToReceiptLines("<table><tr><td>a<td>b<tr><td>c</table>"),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("htmlToReceiptLines: text that is not shown", () => {
  it("ignores script, style, head, title, noscript and template", () => {
    const html =
      "<html><head><title>Hidden title</title><style>p{color:red}</style>" +
      "<script>var a = 1;</script></head><body>" +
      "<noscript>Enable JS</noscript><template><p>tpl</p></template>" +
      "<p>Visible</p><script>alert(1)</script><style>.x{}</style></body></html>";
    expect(htmlToReceiptLines(html)).toEqual(["Visible"]);
  });

  it("does not use a JSON-LD script as lines (it is for the structured reader)", () => {
    const html =
      '<script type="application/ld+json">{"@type":"Order"}</script><p>Hi</p>';
    expect(htmlToReceiptLines(html)).toEqual(["Hi"]);
  });

  it("drops an image inside a hidden element", () => {
    expect(
      htmlToReceiptLines('<noscript><img alt="tracker"></noscript><p>x</p>'),
    ).toEqual(["x"]);
  });

  it("ignores comments, including conditional comments", () => {
    expect(
      htmlToReceiptLines("<!-- note -->a<!--[if mso]><p>mso</p><![endif]-->b"),
    ).toEqual(["ab"]);
  });
});

describe("htmlToReceiptLines: images and links", () => {
  it("gives a non-empty image alt its own line", () => {
    expect(
      htmlToReceiptLines('before<img src="x.png" alt="USB-C cable">after'),
    ).toEqual(["before", "[image: USB-C cable]", "after"]);
  });

  it("gives an image with no or empty alt no line", () => {
    expect(
      htmlToReceiptLines('a<img src="x"><img alt=""><img alt="   ">b'),
    ).toEqual(["ab"]);
  });

  it("decodes entities and folds whitespace in an alt", () => {
    expect(
      htmlToReceiptLines('<img alt="Tom &amp;   Jerry&nbsp;box">'),
    ).toEqual(["[image: Tom & Jerry box]"]);
  });

  it("keeps the link text inline and the http(s) href on its own line", () => {
    expect(
      htmlToReceiptLines(
        '<p>Track <a href="https://shop.example.com/track?id=1&amp;x=2">your order</a> now</p>',
      ),
    ).toEqual([
      "Track your order",
      "<https://shop.example.com/track?id=1&x=2>",
      "now",
    ]);
  });

  it("accepts http and a mixed-case scheme, and refuses mailto, tel, javascript, relative and empty hrefs", () => {
    expect(htmlToReceiptLines('<a href="HTTP://a.example/x">a</a>')).toEqual([
      "a",
      "<HTTP://a.example/x>",
    ]);
    for (const href of [
      "mailto:a@b.example",
      "tel:123",
      "javascript:alert(1)",
      "/relative",
      "#top",
      "",
      "  ",
    ]) {
      expect(htmlToReceiptLines(`<a href="${href}">t</a>`)).toEqual(["t"]);
    }
    expect(htmlToReceiptLines("<a>t</a>")).toEqual(["t"]);
  });

  it("puts an image link as the alt line then the href line (what Gmail's text part shows)", () => {
    expect(
      htmlToReceiptLines(
        '<a href="https://shop.example.com/p/1"><img alt="Widget" src="w.png"></a>',
      ),
    ).toEqual(["[image: Widget]", "<https://shop.example.com/p/1>"]);
  });

  it("cuts a very long href inside its brackets, so the line still ends in >", () => {
    const href = "https://t.example.com/" + "a".repeat(2000);
    const [line] = htmlToReceiptLines(`<a href="${href}">x</a>`).slice(1);
    expect(line.length).toBe(MAX_LINE_LENGTH);
    expect(line.startsWith("<https://t.example.com/")).toBe(true);
    expect(line.endsWith(">")).toBe(true);
  });
});

describe("htmlToReceiptLines: characters", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(
      htmlToReceiptLines("<p>5 &lt; 6 &amp; &euro;9 &#8364;9 &#x20AC;9</p>"),
    ).toEqual(["5 < 6 & €9 €9 €9"]);
  });

  it("folds non-breaking spaces to a space", () => {
    expect(htmlToReceiptLines("<p>12&nbsp;345,67&nbsp;zł</p>")).toEqual([
      "12 345,67 zł",
    ]);
    expect(htmlToReceiptLines("<p>a  b</p>")).toEqual(["a b"]);
  });

  it("drops invisible characters, as a text line does", () => {
    expect(htmlToReceiptLines("<p>a​b‌­c‫d</p>")).toEqual(["abcd"]);
    expect(htmlToReceiptLines("<p>​ ‌</p><p>x</p>")).toEqual(["x"]);
  });

  it("does not decode entities inside a script", () => {
    const { jsonLd } = collectStructuredData(
      '<script type="application/ld+json">{"a":"x &amp; y"}</script>',
    );
    expect(jsonLd).toEqual(['{"a":"x &amp; y"}']);
  });
});

describe("htmlToReceiptLines: the Gmail forward wrapper", () => {
  it("reads the forwarded header block and the original body as lines", () => {
    const html =
      '<div dir="ltr"><div class="gmail_quote">' +
      '<div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>' +
      'From: <strong class="gmail_sendername" dir="auto">Shop</strong> ' +
      '<span dir="auto">&lt;<a href="mailto:orders@shop.example.com">orders@shop.example.com</a>&gt;</span><br>' +
      "Date: Mon, 4 May 2026 at 10:00<br>Subject: Order A-1<br>To: me@example.com<br></div>" +
      "<br><br><table><tr><td>Widget</td><td>9,99 zł</td></tr></table></div></div>";
    expect(htmlToReceiptLines(html)).toEqual([
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Date: Mon, 4 May 2026 at 10:00",
      "Subject: Order A-1",
      "To: me@example.com",
      "Widget",
      "9,99 zł",
    ]);
  });
});

describe("htmlToReceiptLines: bounds and malformed input", () => {
  it("returns no lines for empty or non-string input", () => {
    expect(htmlToReceiptLines("")).toEqual([]);
    expect(htmlToReceiptLines(undefined as unknown as string)).toEqual([]);
    expect(htmlToReceiptLines(null as unknown as string)).toEqual([]);
    expect(htmlToReceiptLines("   \n ")).toEqual([]);
  });

  it("reads malformed HTML without throwing: stray closes, unclosed tags, broken attributes", () => {
    expect(
      htmlToReceiptLines("</div></span>a<p>b<div>c<b>d<td x=>e<<>>f"),
    ).toEqual(["a", "b", "cd", "e<<>>f"]);
    expect(() =>
      htmlToReceiptLines('<a href="unterminated>text<p>more'),
    ).not.toThrow();
    expect(htmlToReceiptLines("plain text only")).toEqual(["plain text only"]);
  });

  it("cuts a line to the line bound", () => {
    const [line] = htmlToReceiptLines(
      `<p>${"x".repeat(MAX_LINE_LENGTH + 300)}</p>`,
    );
    expect(line).toHaveLength(MAX_LINE_LENGTH);
  });

  it("keeps at most the line cap and stays linear on a huge input", () => {
    const html = "<p>x</p>".repeat(MAX_PARSE_LINES + 500);
    expect(htmlToReceiptLines(html)).toHaveLength(MAX_PARSE_LINES);
    const big = "<td>cell</td>".repeat(60_000);
    expect(big.length).toBeLessThanOrEqual(HTML_LINES_MAX_INPUT_CHARS);
    const started = Date.now();
    expect(htmlToReceiptLines(big)).toHaveLength(MAX_PARSE_LINES);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reads only the first million characters", () => {
    const html =
      "<p>first</p>" + " ".repeat(HTML_LINES_MAX_INPUT_CHARS) + "<p>late</p>";
    expect(htmlToReceiptLines(html)).toEqual(["first"]);
  });

  it("survives text with no breaks that is far longer than a line, and mostly whitespace", () => {
    const wide = `<p>${"a ".repeat(50_000)}</p><p>next</p>`;
    const lines = htmlToReceiptLines(wide);
    // Cut to the line bound, then trimmed (the cut may land on a space).
    expect(lines[0].length).toBeGreaterThanOrEqual(MAX_LINE_LENGTH - 1);
    expect(lines[0].length).toBeLessThanOrEqual(MAX_LINE_LENGTH);
    expect(lines[1]).toBe("next");
    const padded = `<p>${" \n".repeat(200_000)}word</p>`;
    expect(htmlToReceiptLines(padded)).toEqual(["word"]);
  });

  it("survives very deep nesting: the stack is bounded and the close tags stay balanced", () => {
    const depth = HTML_SCAN_MAX_DEPTH + 200;
    const html =
      "<span>".repeat(depth) +
      "deep" +
      "</span>".repeat(depth) +
      "<p>after</p>";
    expect(htmlToReceiptLines(html)).toEqual(["deep", "after"]);
  });

  it("handles 100,000 unclosed tags without a recursion or a blow-up", () => {
    const html = "<div>x".repeat(100_000);
    expect(htmlToReceiptLines(html)).toHaveLength(MAX_PARSE_LINES);
  });

  it("is deterministic and pure: the same input gives equal output twice", () => {
    const html = "<table><tr><td>A</td><td>B</td></tr></table>";
    expect(htmlToReceiptLines(html)).toEqual(htmlToReceiptLines(html));
  });
});

describe("collectStructuredData: JSON-LD scripts", () => {
  it("collects the text of each application/ld+json script, wherever it sits", () => {
    const html =
      '<html><head><script type="application/ld+json">{"a":1}</script></head>' +
      '<body><script TYPE="Application/LD+JSON; charset=utf-8">{"b":2}</script>' +
      '<script type="text/javascript">var x</script><script>var y</script></body></html>';
    expect(collectStructuredData(html).jsonLd).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("skips empty scripts and keeps the other scripts out", () => {
    expect(
      collectStructuredData('<script type="application/ld+json">  </script>')
        .jsonLd,
    ).toEqual([]);
    expect(
      collectStructuredData('<script type="application/json">{}</script>')
        .jsonLd,
    ).toEqual([]);
  });

  it("collects at most 50 scripts", () => {
    const html = '<script type="application/ld+json">{}</script>'.repeat(
      JSON_LD_MAX_SCRIPTS + 20,
    );
    expect(collectStructuredData(html).jsonLd).toHaveLength(
      JSON_LD_MAX_SCRIPTS,
    );
  });

  it("drops a script over 100 KB and keeps the next one", () => {
    const big = `{"x":"${"a".repeat(JSON_LD_MAX_SCRIPT_CHARS)}"}`;
    const html =
      `<script type="application/ld+json">${big}</script>` +
      '<script type="application/ld+json">{"ok":1}</script>';
    expect(collectStructuredData(html).jsonLd).toEqual(['{"ok":1}']);
  });

  it("is the same data scanReceiptHtml returns beside the lines", () => {
    const html = '<p>Hi</p><script type="application/ld+json">{"a":1}</script>';
    const scan = scanReceiptHtml(html);
    expect(scan.lines).toEqual(["Hi"]);
    expect(scan.structured.jsonLd).toEqual(['{"a":1}']);
  });
});

describe("collectStructuredData: microdata", () => {
  it("builds the item tree from itemscope, itemtype and itemprop nesting", () => {
    const html = `
      <div itemscope itemtype="http://schema.org/Order">
        <meta itemprop="orderNumber" content="A-100">
        <div itemprop="seller" itemscope itemtype="http://schema.org/Organization">
          <span itemprop="name">Example   Shop</span>
        </div>
        <div itemprop="orderedItem" itemscope itemtype="http://schema.org/OrderItem">
          <meta itemprop="orderQuantity" content="2">
          <div itemprop="orderedItem" itemscope itemtype="http://schema.org/Product">
            <span itemprop="name">Widget</span>
          </div>
        </div>
        <link itemprop="url" href="https://shop.example.com/o/A-100">
        <time itemprop="orderDate" datetime="2026-05-04">May 4</time>
        <data itemprop="price" value="19.98">19,98</data>
      </div>`;
    const { microdata } = collectStructuredData(html);
    expect(microdata).toHaveLength(1);
    expect(microdata[0].types).toEqual(["http://schema.org/Order"]);
    expect(microdata[0].props.map((p) => p.name)).toEqual([
      "orderNumber",
      "seller",
      "orderedItem",
      "url",
      "orderDate",
      "price",
    ]);
    const seller = microdata[0].props[1].value as {
      types: string[];
      props: unknown[];
    };
    expect(seller.types).toEqual(["http://schema.org/Organization"]);
    expect(seller.props).toEqual([{ name: "name", value: "Example Shop" }]);
    const item = microdata[0].props[2].value as {
      props: { name: string; value: unknown }[];
    };
    expect(item.props[0]).toEqual({ name: "orderQuantity", value: "2" });
    expect(item.props[1].name).toBe("orderedItem");
    expect(microdata[0].props[3].value).toBe(
      "https://shop.example.com/o/A-100",
    );
    expect(microdata[0].props[4].value).toBe("2026-05-04");
    expect(microdata[0].props[5].value).toBe("19.98");
  });

  it("reads img src, content on any element, and several names in one itemprop", () => {
    const html =
      '<div itemscope><img itemprop="image" src="https://i.example.com/a.png">' +
      '<span itemprop="a b" content="v">shown</span></div>';
    const [item] = collectStructuredData(html).microdata;
    expect(item.props).toEqual([
      { name: "image", value: "https://i.example.com/a.png" },
      { name: "a", value: "v" },
      { name: "b", value: "v" },
    ]);
  });

  it("reads the text of an itemprop element including its inline children", () => {
    const [item] = collectStructuredData(
      '<div itemscope><p itemprop="description">A <b>bold</b>\n claim</p></div>',
    ).microdata;
    expect(item.props).toEqual([
      { name: "description", value: "A bold claim" },
    ]);
  });

  it("ignores an itemprop outside any item, and an empty value", () => {
    const html =
      '<span itemprop="name">stray</span><div itemscope><meta itemprop="x" content="">' +
      '<span itemprop="y"> </span></div>';
    const { microdata } = collectStructuredData(html);
    expect(microdata).toHaveLength(1);
    expect(microdata[0].props).toEqual([]);
  });

  it("makes an itemscope that is nobody's property a top-level item of its own", () => {
    const html =
      '<div itemscope itemtype="https://schema.org/Order"><div itemscope itemtype="https://schema.org/Invoice"></div></div>';
    const { microdata } = collectStructuredData(html);
    expect(microdata.map((i) => i.types[0])).toEqual([
      "https://schema.org/Order",
      "https://schema.org/Invoice",
    ]);
  });

  it("works in a table, whatever the cells hold", () => {
    const html =
      '<table itemscope itemtype="http://schema.org/Order"><tr><td itemprop="orderNumber">N-1</td>' +
      '<td itemprop="price">9,99</td></tr></table>';
    const [item] = collectStructuredData(html).microdata;
    expect(item.props).toEqual([
      { name: "orderNumber", value: "N-1" },
      { name: "price", value: "9,99" },
    ]);
  });

  it("caps the number of items and the nesting depth", () => {
    const many =
      '<div itemscope itemtype="http://schema.org/Order"></div>'.repeat(
        MICRODATA_MAX_ITEMS + 50,
      );
    expect(collectStructuredData(many).microdata).toHaveLength(
      MICRODATA_MAX_ITEMS,
    );

    const nested =
      '<div itemscope itemtype="http://schema.org/Order">'.repeat(
        MICRODATA_MAX_DEPTH + 5,
      ) + "</div>".repeat(MICRODATA_MAX_DEPTH + 5);
    expect(collectStructuredData(nested).microdata.length).toBeLessThanOrEqual(
      MICRODATA_MAX_DEPTH,
    );
  });

  it("bounds a value's length and the number of properties", () => {
    const long = "y".repeat(5000);
    const [item] = collectStructuredData(
      `<div itemscope><span itemprop="a">${long}</span><meta itemprop="b" content="${long}"></div>`,
    ).microdata;
    for (const prop of item.props) {
      expect((prop.value as string).length).toBeLessThanOrEqual(1000);
    }
    const props = '<meta itemprop="p" content="1">'.repeat(3000);
    const [wide] = collectStructuredData(
      `<div itemscope>${props}</div>`,
    ).microdata;
    expect(wide.props.length).toBeLessThanOrEqual(2000);
  });

  it("does not let a property named __proto__ or constructor reach an object's prototype", () => {
    const [item] = collectStructuredData(
      '<div itemscope><meta itemprop="__proto__" content="x"><meta itemprop="constructor" content="y"></div>',
    ).microdata;
    expect(item.props).toEqual([
      { name: "__proto__", value: "x" },
      { name: "constructor", value: "y" },
    ]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("returns nothing for an HTML body with no structured data", () => {
    expect(collectStructuredData("<p>plain</p>")).toEqual({
      jsonLd: [],
      microdata: [],
    });
    expect(collectStructuredData("")).toEqual({ jsonLd: [], microdata: [] });
  });
});
