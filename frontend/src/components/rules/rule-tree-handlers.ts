import type { RuleTreeHandlers } from '@/components/rules/RuleConditionGroup';
import {
  addChild,
  createGroup,
  createLeaf,
  duplicateNode,
  moveNode,
  removeNode,
  updateNode,
  type EditorGroup,
} from '@/lib/rule-tree';

/**
 * The tree operations a group or a card can ask for, each as an edit of the
 * root. `editRoot` is the caller's one way of changing the condition tree (the
 * editor's `edit`, which also clears stale errors), so every route into the
 * tree goes through it.
 */
export function createTreeHandlers(editRoot: (fn: (root: EditorGroup) => EditorGroup) => void): RuleTreeHandlers {
  return {
    replace: (path, node) => editRoot((root) => updateNode(root, path, () => node)),
    add: (groupPath, kind) =>
      editRoot((root) => addChild(root, groupPath, kind === 'leaf' ? createLeaf() : createGroup())),
    remove: (path) => editRoot((root) => removeNode(root, path)),
    move: (path, delta) => editRoot((root) => moveNode(root, path, delta)),
    duplicate: (path) => editRoot((root) => duplicateNode(root, path)),
  };
}
