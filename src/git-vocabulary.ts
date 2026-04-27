import {
  KIND_GIT_COMMENT,
  KIND_GIT_ISSUE,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_PULL_REQUEST_UPDATE,
} from "./events.js"

export const gitCollaborationVocabularyLines = () => [
  `Git collaboration vocabulary: issue, PR/pull request, comment/reply, label, status, and repo-thread references mean NIP-34/Nostr-git repository workflows by default. Issues are kind ${KIND_GIT_ISSUE}; comments/replies are kind ${KIND_GIT_COMMENT}; PRs are kinds ${KIND_GIT_PULL_REQUEST}/${KIND_GIT_PULL_REQUEST_UPDATE}.`,
  "Use `openteam repo publish ...` and the active repo relay policy for repo-side discussion and review artifacts. Use GitHub/GitLab issue, PR, or comment systems only when the task explicitly names that forge.",
  "Plain `git` commands still mean local Git SCM operations such as inspect, branch, commit, and push.",
]
