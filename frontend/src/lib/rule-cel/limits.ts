/**
 * The size limits of a condition tree, checked where the text is, so the
 * message points at the part that goes over instead of at the whole rule.
 * The numbers are the server's (`lib/rule-fields.ts`).
 */
import { celError } from '@/lib/rule-cel/types';
import {
  MAX_RULE_CONDITION_DEPTH,
  MAX_RULE_CONDITION_LEAVES,
  MAX_RULE_CONDITION_NODES,
} from '@/lib/rule-fields';
import type { EditorGroup, EditorNode } from '@/lib/rule-tree';

/** Throws the first limit the tree goes over, at the position `at` gives for that node. */
export function checkLimits(root: EditorGroup, at: (node: EditorNode) => number): void {
  let nodes = 0;
  let leaves = 0;
  const walk = (node: EditorNode, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_RULE_CONDITION_NODES) {
      throw celError(at(node), 'maxNodes', { max: MAX_RULE_CONDITION_NODES });
    }
    if (node.kind === 'leaf') {
      leaves += 1;
      if (leaves > MAX_RULE_CONDITION_LEAVES) {
        throw celError(at(node), 'maxLeaves', { max: MAX_RULE_CONDITION_LEAVES });
      }
      return;
    }
    if (depth > MAX_RULE_CONDITION_DEPTH) {
      throw celError(at(node), 'maxDepth', { max: MAX_RULE_CONDITION_DEPTH });
    }
    node.children.forEach((child) => walk(child, depth + 1));
  };
  walk(root, 1);
}
