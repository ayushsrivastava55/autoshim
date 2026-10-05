import { request as github } from "@octokit/request";
github("GET /repos/{owner}/{repo}", { owner: "example", repo: "demo" });
