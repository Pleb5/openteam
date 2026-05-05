import {
  KIND_GIT_COMMENT,
  KIND_GIT_ISSUE,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_PULL_REQUEST_UPDATE,
} from "./events.js"

export const gitCollaborationVocabularyLines = () => [
  `Nostr-git event map for this run: issues are kind ${KIND_GIT_ISSUE}; comments/replies are kind ${KIND_GIT_COMMENT}; PRs are kinds ${KIND_GIT_PULL_REQUEST}/${KIND_GIT_PULL_REQUEST_UPDATE}.`,
  "Use `openteam repo policy` for the active repo relay policy and `openteam repo publish ...` for assigned repo-visible writes.",
  "Plain `git` commands still mean local Git SCM operations such as inspect, branch, commit, and push.",
]
