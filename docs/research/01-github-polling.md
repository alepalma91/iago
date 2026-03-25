# GitHub Polling & Notification Strategies for PR Review Detection

## Research Summary

This document evaluates strategies for a CLI tool to efficiently detect when the authenticated user is assigned as a PR reviewer on GitHub. The goal is **maximum efficiency**: minimal API calls, minimal latency, and staying well within rate limits.

---

## 1. Available Detection Strategies

### Strategy A: REST Notifications API (Recommended Primary)

**Endpoint:** `GET /notifications`

The notifications API is purpose-built for polling and offers the best efficiency characteristics.

#### Key Features
- **Conditional requests with `Last-Modified` / `If-Modified-Since`**: When no new notifications exist, GitHub returns `304 Not Modified` which **does not count against the rate limit**
- **`X-Poll-Interval` header**: GitHub tells you exactly how often to poll (typically 60s; increases under server load)
- **`reason` field filtering**: Notifications include a `reason` field; `review_requested` indicates a review assignment
- **`participating` parameter**: Filters to direct participation/mentions only
- **`since` parameter**: ISO 8601 timestamp to only get notifications after a certain time

#### Optimal Polling Flow
```
1. GET /notifications (with auth header)
   -> Store `Last-Modified` header from response
   -> Store `X-Poll-Interval` header value (e.g., 60)

2. Wait X-Poll-Interval seconds

3. GET /notifications (with `If-Modified-Since: <stored value>`)
   -> If 304: no new notifications, costs 0 rate limit
   -> If 200: parse notifications, filter for reason == "review_requested"
   -> Update stored Last-Modified
   -> Repeat from step 2
```

#### Rate Limit Impact
- **304 responses: 0 rate limit cost** (when using authenticated conditional requests)
- **200 responses: 1 request** from the 5,000/hour budget
- In practice, a tool polling every 60s would use ~0 rate limit during quiet periods and only 1 request per burst of new notifications

#### Response Structure (relevant fields)
```json
{
  "id": "1",
  "reason": "review_requested",
  "subject": {
    "title": "PR Title",
    "url": "https://api.github.com/repos/owner/repo/pulls/123",
    "type": "PullRequest"
  },
  "repository": {
    "full_name": "owner/repo"
  },
  "updated_at": "2024-01-01T00:00:00Z",
  "unread": true
}
```

#### Pros
- Purpose-built for polling; most efficient option
- Conditional requests are free (304 = no rate limit cost)
- GitHub manages the notification subscription automatically
- Covers all repos the user has access to in a single call
- `reason` field provides direct filtering for `review_requested`

#### Cons
- Latency is bounded by `X-Poll-Interval` (minimum ~60s)
- `reason` can change per-thread (e.g., if you're also the author)
- No server-push; still requires polling loop

---

### Strategy B: GraphQL Search API

**Query:** `search(query: "type:pr state:open review-requested:<username>")`

Use GraphQL to directly search for PRs where the user is a requested reviewer.

#### Example Query
```graphql
query PendingReviews($login: String!) {
  search(
    query: "type:pr state:open review-requested:$login"
    type: ISSUE
    first: 50
  ) {
    issueCount
    edges {
      node {
        ... on PullRequest {
          number
          title
          url
          createdAt
          repository { nameWithOwner }
          author { login }
          reviewRequests(first: 10) {
            nodes {
              requestedReviewer {
                ... on User { login }
                ... on Team { name slug }
              }
            }
          }
        }
      }
    }
  }
}
```

#### Rate Limit Impact
- GraphQL uses a **point-based** system: 5,000 points/hour for personal access tokens
- Cost formula: sum of (connection nodes requested / 100), minimum 1 point per call
- The above query costs ~1 point per call
- **No conditional request support** for GraphQL (no ETags/304)
- Polling every 60s = ~60 points/hour (1.2% of budget)

#### Viewer Query (get current user dynamically)
```graphql
query { viewer { login } }
```

#### Batch Query Pattern (combine multiple searches)
```graphql
query ReviewDashboard {
  pendingReviews: search(
    query: "type:pr state:open review-requested:@me"
    type: ISSUE, first: 50
  ) { issueCount edges { node { ... on PullRequest { url title } } } }

  myOpenPRs: search(
    query: "type:pr state:open author:@me"
    type: ISSUE, first: 50
  ) { issueCount edges { node { ... on PullRequest { url title } } } }
}
```

#### Pros
- Returns rich, structured PR data in a single call
- Can combine multiple queries in one request (batch)
- Directly answers "what PRs need my review right now?"
- Supports team review requests: `team-review-requested:ORG/TEAM`

#### Cons
- No conditional request support (every poll costs points)
- No push mechanism; requires polling
- Slightly higher latency per request vs REST
- Must know the username (use `viewer { login }` first)
- Notifications API is still needed for "new assignment" detection vs "current state"

---

### Strategy C: REST Search API

**Endpoint:** `GET /search/issues?q=type:pr+state:open+review-requested:<username>`

#### Rate Limit Impact
- Search API has a **special rate limit**: 30 requests/minute for authenticated users
- This is separate from the main 5,000/hour limit
- Supports conditional requests (ETags) for 304 responses

#### Pros
- Simple REST call, easy to implement
- Supports ETags for conditional requests
- Rich query syntax

#### Cons
- Stricter rate limit (30/min) than notifications or GraphQL
- Returns less structured data than GraphQL
- Still polling-based

---

### Strategy D: `gh` CLI as Subprocess

Use the GitHub CLI directly from the tool.

#### Key Commands
```bash
# Find PRs requesting your review
gh search prs --review-requested=@me --state=open

# Alternative using pr list with search
gh pr list --search "review-requested:@me" --state open

# Raw API call with conditional requests
gh api /notifications \
  --header "If-Modified-Since: Thu, 05 Jul 2023 15:07:19 GMT" \
  --include

# GraphQL via gh
gh api graphql -f query='{ search(query: "type:pr state:open review-requested:@me", type: ISSUE, first: 50) { issueCount edges { node { ... on PullRequest { url title repository { nameWithOwner } } } } } }'
```

#### Pros
- Handles authentication automatically (uses stored `gh` credentials)
- No need to manage tokens in the CLI tool
- Well-tested, maintained by GitHub
- Supports both REST and GraphQL
- `--include` flag returns headers (useful for ETag/Last-Modified capture)

#### Cons
- Subprocess overhead per call
- Parsing stdout is fragile
- Rate limits still apply (shared with other `gh` usage)
- Less control over request headers and caching

---

### Strategy E: Webhooks (Not Recommended for CLI)

**Event:** `pull_request` with action `review_requested`

#### How It Works
- GitHub sends an HTTP POST to a registered URL when a review is requested
- Payload includes the PR details and requested reviewer
- Near-instant notification (typically < 1 second)

#### Local Development Tools
- **Smee.io**: Free webhook proxy for development (not production)
- **ngrok**: Exposes local port to internet
- **localtunnel**: Similar to ngrok
- **Hookdeck Console**: Managed webhook infrastructure

#### Why Not Recommended for This CLI Tool
- Requires a publicly accessible server or tunnel
- Complex setup for end users (not "install and run")
- Tunneling services add latency and reliability concerns
- Not suitable for a lightweight CLI tool
- Security implications of exposing local endpoints

#### When Webhooks Make Sense
- If the tool evolves into a hosted service/daemon
- If paired with a lightweight cloud function (AWS Lambda, Cloudflare Worker)
- For organizations with existing webhook infrastructure

---

## 2. Rate Limit Budget Analysis

### Authenticated User: 5,000 REST requests/hour, 5,000 GraphQL points/hour

| Strategy | Cost per Poll | Polls/Hour (60s) | Budget Used | % of Limit |
|----------|--------------|-------------------|-------------|------------|
| REST Notifications (304) | 0 | 60 | 0 | 0% |
| REST Notifications (200) | 1 | 60 | 60 | 1.2% |
| GraphQL Search | 1 point | 60 | 60 | 1.2% |
| REST Search | 1 | 60 | 60* | 3.3%** |
| gh CLI (wraps above) | same | same | same | same |

*REST Search has a separate 30/min limit
**Percentage of the 30/min search-specific limit

### Recommended Budget Allocation
- **Primary polling (Notifications API)**: ~0-60 requests/hour (conditional)
- **Enrichment (GraphQL)**: ~10-20 points/hour (on-demand when new notification detected)
- **Reserve**: ~4,900 requests/hour for user's other tools/workflows

---

## 3. Recommended Architecture

### Hybrid Approach: Notifications + GraphQL Enrichment

```
┌─────────────────────────────────────────┐
│           Polling Loop (60s)            │
│                                         │
│  1. GET /notifications                  │
│     (If-Modified-Since conditional)     │
│                                         │
│  2. If 304 → sleep(X-Poll-Interval)    │
│     If 200 → filter reason ==           │
│              "review_requested"          │
│                                         │
│  3. For new review requests:            │
│     GraphQL query for PR details        │
│     (title, author, repo, files, etc.)  │
│                                         │
│  4. Trigger notification to user        │
│     (macOS native notification)         │
│                                         │
│  5. Cache seen notification IDs         │
│     to prevent duplicates               │
└─────────────────────────────────────────┘
```

### Why This Hybrid?
1. **Notifications API** is cheapest for detection (304 = free)
2. **GraphQL** provides rich PR data in a single request when needed
3. Together they minimize total API calls while maximizing data richness
4. The `gh` CLI can be used as the HTTP transport layer (handles auth)

### Implementation via `gh` CLI

```bash
# Step 1: Poll notifications (capture headers)
RESPONSE=$(gh api /notifications \
  --header "If-Modified-Since: $LAST_MODIFIED" \
  --include 2>&1)

# Step 2: Parse headers
NEW_LAST_MODIFIED=$(echo "$RESPONSE" | grep "Last-Modified:" | cut -d' ' -f2-)
POLL_INTERVAL=$(echo "$RESPONSE" | grep "X-Poll-Interval:" | awk '{print $2}')
HTTP_STATUS=$(echo "$RESPONSE" | head -1 | awk '{print $2}')

# Step 3: If 200, filter for review requests
if [ "$HTTP_STATUS" = "200" ]; then
  REVIEW_NOTIFICATIONS=$(echo "$RESPONSE" | jq '[.[] | select(.reason == "review_requested")]')
fi

# Step 4: Enrich with GraphQL if needed
if [ -n "$REVIEW_NOTIFICATIONS" ]; then
  gh api graphql -f query='...'
fi
```

---

## 4. Key Implementation Considerations

### Authentication
- Rely on `gh auth status` to verify authentication
- Use `gh api` for all HTTP requests (inherits auth automatically)
- Required scopes: `notifications` or `repo`

### Caching
- Store `Last-Modified` header between polls
- Cache notification thread IDs to deduplicate
- Cache PR metadata to avoid redundant GraphQL queries
- Use a local file or SQLite for persistence across restarts

### Error Handling
- **401**: Token expired; prompt re-authentication
- **403**: Rate limited; respect `Retry-After` header
- **304**: No changes; this is success, not error
- **422**: Validation error; log and skip
- Network errors: exponential backoff with jitter

### Polling Interval Strategy
```
Base interval: X-Poll-Interval header (default 60s)
On 304: use base interval
On 200 with new reviews: use base interval (don't speed up)
On error: exponential backoff (120s, 240s, 480s, max 900s)
On rate limit: wait until X-RateLimit-Reset timestamp
```

### Important Notification API Behaviors
1. The `reason` field can change for a thread (e.g., `review_requested` -> `author`)
2. Once a reviewer submits a review, they are removed from `requestedReviewers`
3. The `participating` filter includes review requests
4. `since` parameter uses ISO 8601 format: `2024-01-01T00:00:00Z`

---

## 5. Alternative: Direct PR Polling (Without Notifications)

If the notifications API proves insufficient (e.g., reason field changes), a fallback is to directly poll for assigned reviews:

### GraphQL-Only Approach
```graphql
query {
  viewer { login }
  search(query: "type:pr state:open review-requested:@me", type: ISSUE, first: 100) {
    issueCount
    nodes {
      ... on PullRequest {
        id
        number
        title
        url
        createdAt
        updatedAt
        repository { nameWithOwner }
        author { login avatarUrl }
        additions
        deletions
        changedFiles
      }
    }
  }
}
```

**Cost:** ~1 point per poll, 60 polls/hour = 60 points (1.2% of budget)

### Pros of Direct Polling
- Always shows current state (no stale notification issues)
- Rich data in one call
- Simpler logic (no notification -> enrichment pipeline)

### Cons of Direct Polling
- Cannot distinguish "new" vs "already seen" assignments without local state
- No conditional requests (always costs points)
- Slightly higher baseline cost than notification polling with 304s

---

## 6. Existing Tools & Extensions (Prior Art)

| Tool | Approach | Interval | Notes |
|------|----------|----------|-------|
| gh-cleanup-notifications | REST Notifications + Last-Modified | 60s | Adheres to X-Poll-Interval |
| gh-news (chmouel) | REST Notifications | 120s default | Supports GH_NOTIFY_REASON env var for filtering by review_requested |
| gh-dash | REST + GraphQL | Manual refresh | Dashboard-style TUI, not a poller |
| gh-pr-review | REST Pull Requests | On-demand | Inline review comments, LLM-ready |

---

## 7. Final Recommendation

**Use the Hybrid Notifications + GraphQL approach** with `gh` CLI as the transport layer:

1. **Detection**: REST Notifications API with `If-Modified-Since` conditional requests
   - Zero rate limit cost during quiet periods
   - Automatic subscription to all user repos
   - GitHub-managed polling interval via `X-Poll-Interval`

2. **Enrichment**: GraphQL search query on detection
   - Rich PR metadata in a single request
   - Batch multiple queries if needed (e.g., PR details + review comments)

3. **Transport**: `gh api` commands
   - No token management needed
   - Battle-tested HTTP client
   - Automatic retry and auth refresh

4. **Fallback**: Direct GraphQL search polling
   - If notifications API is unreliable for a use case
   - Only costs ~60 points/hour at 60s intervals

### Expected Performance
- **Detection latency**: 60-120 seconds (bounded by X-Poll-Interval)
- **Rate limit usage**: ~0-2% of budget during normal operation
- **Network calls**: 1 per polling interval (quiet), 2 per new assignment (notification + enrichment)

---

## Sources

- [GitHub REST API - Notifications Endpoints](https://docs.github.com/en/rest/activity/notifications)
- [GitHub REST API - Best Practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [GitHub REST API - Rate Limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub GraphQL API - Rate Limits & Query Limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- [GitHub REST API - Review Requests](https://docs.github.com/en/rest/pulls/review-requests)
- [GitHub CLI - gh search prs](https://cli.github.com/manual/gh_search_prs)
- [GitHub CLI - gh api](https://cli.github.com/manual/gh_api)
- [Community Discussion - Rate Limits for Frequent Polling](https://github.com/orgs/community/discussions/156480)
- [Community Discussion - Filtering Notifications for Pending Reviews](https://github.com/orgs/community/discussions/56926)
- [Community Discussion - Notifications GraphQL API](https://github.com/orgs/community/discussions/13056)
- [gh-cleanup-notifications Extension](https://github.com/awendt/gh-cleanup-notifications)
- [gh-news Extension](https://github.com/chmouel/gh-news)
