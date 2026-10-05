import { request } from "@octokit/request";
const route = process.env.GITHUB_ROUTE;
request(route);
