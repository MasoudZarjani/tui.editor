import { sanitizeXSSAttributeValue } from '@/sanitizer/htmlSanitizer';
import { includes } from '@/utils/common';

import { HTMLToWwConvertorMap, FlattenHTMLToWwConvertorMap } from '@t/convertor';
import { MdNode } from '@t/markdown';

import toArray from 'tui-code-snippet/collection/toArray';

const TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTRIBUTE_NAME = '[a-zA-Z_:][a-zA-Z0-9:._-]*';
const UNQUOTED_VALUE = '[^"\'=<>`\\x00-\\x20]+';

const SINGLE_QUOTED_VALUE = "'[^']*'";
const DOUBLE_QUOTED_VALUE = '"[^"]*"';

const ATTRIBUTE_VALUE = `(?:${UNQUOTED_VALUE}|${SINGLE_QUOTED_VALUE}|${DOUBLE_QUOTED_VALUE})`;
const ATTRIBUTE_VALUE_SPEC = `${'(?:\\s*=\\s*'}${ATTRIBUTE_VALUE})`;
const ATTRIBUTE = `${'(?:\\s+'}${ATTRIBUTE_NAME}${ATTRIBUTE_VALUE_SPEC}?)`;

const OPEN_TAG = `<(${TAG_NAME})(${ATTRIBUTE})*\\s*/?>`;
const CLOSE_TAG = `</(${TAG_NAME})\\s*[>]`;

const HTML_TAG = `(?:${OPEN_TAG}|${CLOSE_TAG})`;

export const reHTMLTag = new RegExp(`^${HTML_TAG}`, 'i');

export function getTextWithoutTrailingNewline(text: string) {
  return text[text.length - 1] === '\n' ? text.slice(0, text.length - 1) : text;
}

function isListNode({ type, literal }: MdNode) {
  const matched = type === 'htmlInline' && literal!.match(reHTMLTag);

  if (matched) {
    const [, openTagName, , closeTagName] = matched;
    const tagName = openTagName || closeTagName;

    if (tagName) {
      return includes(['ul', 'ol', 'li'], tagName.toLowerCase());
    }
  }

  return false;
}

function getListItemAttrs({ literal }: MdNode) {
  const task = /data-task/.test(literal!);
  const checked = /data-task-checked/.test(literal!);

  return { task, checked };
}

function getMatchedAttributeValue(rawHTML: string, attrName: string) {
  const wrapper = document.createElement('div');

  wrapper.innerHTML = rawHTML;

  const el = wrapper.firstChild as HTMLElement;

  return el.getAttribute(attrName) || '';
}

function addRawHTMLAttributeToDOM(parent: Node) {
  toArray(parent.childNodes).forEach(child => {
    if (child.nodeType === 1) {
      const rawHTML = child.nodeName.toLowerCase();

      (child as HTMLElement).setAttribute('data-raw-html', rawHTML);

      if (child.childNodes) {
        addRawHTMLAttributeToDOM(child);
      }
    }
  });
}

function createConvertors(convertors: HTMLToWwConvertorMap) {
  const convertorMap: FlattenHTMLToWwConvertorMap = {};

  Object.keys(convertors).forEach(key => {
    const tagNames = key.split(', ');

    tagNames.forEach(tagName => {
      const name = tagName.toLowerCase();

      convertorMap[name] = convertors[key]!;
    });
  });

  return convertorMap;
}

const convertors: HTMLToWwConvertorMap = {
  'b, strong': (state, _, openTagName) => {
    const { strong } = state.schema.marks;

    if (openTagName) {
      state.openMark(strong.create({ rawHTML: openTagName }));
    } else {
      state.closeMark(strong);
    }
  },

  'i, em': (state, _, openTagName) => {
    const { emph } = state.schema.marks;

    if (openTagName) {
      state.openMark(emph.create({ rawHTML: openTagName }));
    } else {
      state.closeMark(emph);
    }
  },

  's, del': (state, _, openTagName) => {
    const { strike } = state.schema.marks;

    if (openTagName) {
      state.openMark(strike.create({ rawHTML: openTagName }));
    } else {
      state.closeMark(strike);
    }
  },

  code: (state, _, openTagName) => {
    const { code } = state.schema.marks;

    if (openTagName) {
      state.openMark(code.create({ rawHTML: openTagName }));
    } else {
      state.closeMark(code);
    }
  },

  a: (state, node, openTagName) => {
    const tag = node.literal!;
    const { link } = state.schema.marks;

    if (openTagName) {
      const linkUrl = getMatchedAttributeValue(tag, 'href');

      state.openMark(
        link.create({
          linkUrl: sanitizeXSSAttributeValue(linkUrl),
          rawHTML: openTagName
        })
      );
    } else {
      state.closeMark(link);
    }
  },

  img: (state, node, openTagName) => {
    const tag = node.literal!;
    const imageUrl = getMatchedAttributeValue(tag, 'src');

    if (imageUrl) {
      const altText = getMatchedAttributeValue(tag, 'alt');
      const { image } = state.schema.nodes;

      state.addNode(image, {
        rawHTML: openTagName,
        imageUrl: sanitizeXSSAttributeValue(imageUrl),
        ...(altText && { altText })
      });
    }
  },

  hr: (state, _, openTagName) => {
    state.addNode(state.schema.nodes.thematicBreak, { rawHTML: openTagName });
  },

  br: (state, node) => {
    const { paragraph } = state.schema.nodes;

    if (node.parent?.type === 'paragraph') {
      if (node.prev) {
        state.openNode(paragraph);
      }

      if (node.next) {
        state.closeNode();
      }
    } else if (node.parent?.type === 'tableCell') {
      if (node.prev?.type === 'text') {
        state.closeNode();
      }

      if (node.next?.type === 'text') {
        state.openNode(paragraph);
      }
    }
  },

  'h1, h2, h3, h4, h5, h6, blockquote, table, tableHead, tableBody, tableRow, tableBodyCell, tableHeadCell': (
    state,
    node
  ) => {
    const container = document.createElement('div');

    container.innerHTML = node.literal!;

    addRawHTMLAttributeToDOM(container);

    state.convertByDOMParser(container.innerHTML, true);
  },

  pre: (state, node, openTagName) => {
    const container = document.createElement('div');

    container.innerHTML = node.literal!;

    const literal = container.firstChild?.firstChild?.textContent;

    state.openNode(state.schema.nodes.codeBlock, { rawHTML: openTagName });
    state.addText(getTextWithoutTrailingNewline(literal!));
    state.closeNode();
  },

  'ul, ol': (state, node, openTagName) => {
    // in the table cell, '<ul>', '<ol>' is parsed as 'htmlInline' node
    if (node.parent!.type === 'tableCell') {
      const { bulletList, orderedList, paragraph } = state.schema.nodes;
      const list = openTagName === 'ul' ? bulletList : orderedList;

      if (openTagName) {
        if (node.prev && !isListNode(node.prev)) {
          state.closeNode();
        }

        state.openNode(list, { rawHTML: openTagName });
      } else {
        state.closeNode();

        if (node.next && !isListNode(node.next)) {
          state.openNode(paragraph);
        }
      }
    } else {
      const container = document.createElement('div');

      container.innerHTML = node.literal!;

      addRawHTMLAttributeToDOM(container);

      state.convertByDOMParser(container.innerHTML, true);
    }
  },

  li: (state, node, openTagName) => {
    // in the table cell, '<li>' is parsed as 'htmlInline' node
    if (node.parent?.type === 'tableCell') {
      const { listItem, paragraph } = state.schema.nodes;

      if (openTagName) {
        const attrs = getListItemAttrs(node);

        if (node.prev && !isListNode(node.prev)) {
          state.closeNode();
        }

        state.openNode(listItem, { rawHTML: openTagName, ...attrs });

        if (node.next && !isListNode(node.next)) {
          state.openNode(paragraph);
        }
      } else {
        if (node.prev && !isListNode(node.prev)) {
          state.closeNode();
        }

        state.closeNode();
      }
    } else {
      const container = document.createElement('div');

      container.innerHTML = node.literal!;

      addRawHTMLAttributeToDOM(container);

      state.convertByDOMParser(container.innerHTML, true);
    }
  }
};

export const htmlToWwConvertors = createConvertors(convertors);
