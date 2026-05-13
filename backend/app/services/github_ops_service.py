from __future__ import annotations

from typing import Any

import httpx

from app.core.config import settings


class GitHubOpsService:
    def status(self) -> dict[str, Any]:
        return {
            "enabled": bool(settings.github_token and settings.github_owner and settings.github_repo),
            "project_enabled": bool(settings.github_token and settings.github_project_id),
            "owner": settings.github_owner,
            "repo": settings.github_repo,
            "project_id": settings.github_project_id,
        }

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {settings.github_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _repo_slug(self) -> str:
        if not (settings.github_owner and settings.github_repo):
            raise RuntimeError("GitHub repo sync is not configured. Add GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO.")
        return f"{settings.github_owner}/{settings.github_repo}"

    async def create_issue(self, title: str, body: str, labels: list[str] | None = None) -> dict[str, Any]:
        repo = self._repo_slug()
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"https://api.github.com/repos/{repo}/issues",
                headers=self._headers(),
                json={"title": title, "body": body, "labels": labels or []},
            )
        if response.status_code >= 400:
            raise RuntimeError(f"GitHub issue creation failed: {response.status_code} {response.text[:220]}")
        payload = response.json()
        issue = {
            "number": payload.get("number"),
            "html_url": payload.get("html_url"),
            "node_id": payload.get("node_id"),
            "title": payload.get("title"),
        }
        if settings.github_project_id and issue["node_id"]:
            await self._add_item_to_project(issue["node_id"])
        return issue

    async def add_issue_comment(self, issue_number: int, body: str) -> dict[str, Any]:
        repo = self._repo_slug()
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"https://api.github.com/repos/{repo}/issues/{issue_number}/comments",
                headers=self._headers(),
                json={"body": body},
            )
        if response.status_code >= 400:
            raise RuntimeError(f"GitHub issue comment failed: {response.status_code} {response.text[:220]}")
        payload = response.json()
        return {"id": payload.get("id"), "html_url": payload.get("html_url")}

    async def review_pull_request(self, pr_number: int, body: str, event: str = "COMMENT") -> dict[str, Any]:
        repo = self._repo_slug()
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"https://api.github.com/repos/{repo}/pulls/{pr_number}/reviews",
                headers=self._headers(),
                json={"body": body, "event": event},
            )
        if response.status_code >= 400:
            raise RuntimeError(f"GitHub PR review failed: {response.status_code} {response.text[:220]}")
        payload = response.json()
        return {"id": payload.get("id"), "html_url": payload.get("html_url"), "state": payload.get("state")}

    async def _add_item_to_project(self, content_node_id: str) -> None:
        if not settings.github_project_id:
            return
        query = """
        mutation AddProjectV2ItemById($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
            item {
              id
            }
          }
        }
        """
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                "https://api.github.com/graphql",
                headers={
                    **self._headers(),
                    "Content-Type": "application/json",
                },
                json={"query": query, "variables": {"projectId": settings.github_project_id, "contentId": content_node_id}},
            )
        if response.status_code >= 400:
            raise RuntimeError(f"GitHub Project sync failed: {response.status_code} {response.text[:220]}")
        payload = response.json()
        if payload.get("errors"):
            raise RuntimeError(f"GitHub Project sync failed: {payload['errors'][0].get('message', 'unknown error')}")


github_ops_service = GitHubOpsService()
