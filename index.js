const core = require('@actions/core');
const github = require('@actions/github');
const token = core.getInput('token');
const unassignInactiveInHours = core.getInput('unassign_inactive_in_hours');
const unassignInactiveMessage = core.getInput('unassign_inactive_message');
const warningInactiveInHours = core.getInput('warning_inactive_in_hours');
const warningInactiveMessage = core.getInput('warning_inactive_message');
const officeHours = core.getInput('office_hours');
const repoOwner = github.context.repo.owner;
const repo = github.context.repo.repo;
const octokit = github.getOctokit(token);

async function getOpenIssues(repoOwner, repo) {
  var response = null;
  try {
    response = await octokit.issues.listForRepo({
      owner: repoOwner,
      repo: repo,
      state: 'open',
      per_page: 100
    });
  }
  catch (e) {
    console.log(e.message);
  }
  return response;
}

function toUnixTimestamp(timestamp) {
  const unixTimestamp = new Date(timestamp).getTime();
  return unixTimestamp;
}

async function getTimeInactiveInHours(issue) {
  var lastUpdated = null;

  // Get the latest comment, ignoring comments from the bot.
  const comments = await octokit.issues.listComments({
    owner: repoOwner,
    repo: repo,
    issue_number: issue.number
  });
  const commentsAry = comments.data.sort((a, b) => {
    return toUnixTimestamp(b.created_at) - toUnixTimestamp(a.created_at);
  });
  for (var i = 0; i < commentsAry.length; i++) {
    const comment = commentsAry[i];
    if (comment.user.login === 'github-actions[bot]') {
      continue;
    }
    else {
      lastUpdated = comment.created_at;
      break;
    }
  }

  if (!lastUpdated) {
    // If we get here, it means there were no comments, or they were all from
    // the bot. So the update time should be the issue creation time.
    lastUpdated = issue.created_at;
  }

  // Check the latest assignment event -- in the case it was recently assigned,
  // we want that to count as an update.
  const events = await octokit.issues.listEvents({
    owner: repoOwner,
    repo: repo,
    issue_number: issue.number
  });
  const eventsAry = events.data.sort((a, b) => {
    return toUnixTimestamp(b.created_at) - toUnixTimestamp(a.created_at);
  });
  for (var i = 0; i < eventsAry.length; i++) {
    const event = eventsAry[i];
    if (event.event === 'assigned') {
      if (toUnixTimestamp(event.created_at) > toUnixTimestamp(lastUpdated)) {
        lastUpdated = event.created_at;
      }
      break; // Found the latest event, no need to continue
    }
  }

  // Convert lastUpdated to timeInactiveInHours
  var timeInactiveInHours = null;
  try {
    timeInactiveInHours = Math.round(
      (Date.now() - toUnixTimestamp(lastUpdated)) / (1000 * 60 * 60)
    );
  }
  catch (e) {
    console.log(e.message);
  }
  return timeInactiveInHours;
}

async function main() {
  // Get all open issues, including PRs.
  const issuesRes = await getOpenIssues(repoOwner, repo);
  if (!issuesRes) return;

  // Remove pull requests -- we only want issues under the "Issues" tab of GitHub
  var issuesAry = issuesRes.data;
  issuesAry = issuesAry.filter(issue => {
    return issue.pull_request === undefined;
  });

  // For inactive issues, unassign the issue or post a warning message
  // in it that it will be unassigned in the near future.
  var unassignedIssues = [];
  var warnedIssues = [];
  for (var i = 0; i < issuesAry.length; i++) {
    const issue = issuesAry[i];
    const timeInactiveInHours = await getTimeInactiveInHours(issue);
    if (timeInactiveInHours === null) return;
    console.log(`timeInactiveInHours=${timeInactiveInHours}`);
    if (timeInactiveInHours >= unassignInactiveInHours &&
        issue.assignees.length > 0
    ) {
      ////////////////////////
      // Unassign the issue //
      ////////////////////////
      // Post a message
      const body =  `This issue has been inactive for ${timeInactiveInHours} ` +
                    `hours (${(timeInactiveInHours/24).toFixed(2)} days) ` +
                    `and is past the limit of ${unassignInactiveInHours} ` +
                    `hours (${(unassignInactiveInHours/24).toFixed(2)} days) ` +
                    `so is being unassigned.` +
                    `${unassignInactiveMessage} \n `
      try {
        await octokit.issues.createComment({
          owner: repoOwner,
          repo: repo,
          issue_number: issue.number,
          body: body
        });
      }
      catch (e) {
        console.log(e.message);
      }

      // Unassign the issue
      const assigneesAry = issue.assignees.map(assignee => {
        return assignee.login;
      });
      try {
        await octokit.issues.removeAssignees({
          owner: repoOwner,
          repo: repo,
          issue_number: issue.number,
          assignees: assigneesAry
        });
        console.log("Pushing to unassignedIssues");
        unassignedIssues.push(issue.number);
      }
      catch (e) {
        console.log(e.message);
      }
    }
    else if (timeInactiveInHours >= warningInactiveInHours &&
             issue.assignees.length > 0
    ) {
      ///////////////////////
      // Post in the issue //
      ///////////////////////
      // First check to make sure the previous comment is not from the bot so
      // we don't get a spam of comments.
      const comments = await octokit.issues.listComments({
        owner: repoOwner,
        repo: repo,
        issue_number: issue.number
      });
      if (comments.data.length === 0 ||
          comments.data[comments.data.length - 1].user.login !== 'github-actions[bot]'
      ) {
        const willBeUnassignedInHours = unassignInactiveInHours - timeInactiveInHours;
        const body = `This issue has been inactive for ${timeInactiveInHours} ` +
                     `hours (${(timeInactiveInHours/24).toFixed(2)} days) ` +
                     `and will be unassigned after ${willBeUnassignedInHours} ` +
                     `more hours (${(willBeUnassignedInHours/24).toFixed(2)} days). ` +
                     `If you have questions, you can send an email to coreteam@codethesaur.us\n\n` + 
                     `${warningInactiveMessage}`;
        try {
          await octokit.issues.createComment({
            owner: repoOwner,
            repo: repo,
            issue_number: issue.number,
            body: body
          });
          warnedIssues.push(issue.number);
        }
        catch (e) {
          console.log(e.message);
        }
      }
    }
  }

  core.setOutput('unassigned_issues', unassignedIssues.join(','));
  core.setOutput('warned_issues', warnedIssues.join(','));
}

main();
