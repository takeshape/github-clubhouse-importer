const Octokit = require('@octokit/rest');
const Clubhouse = require('clubhouse-lib');
const fetch = require('node-fetch');
const ora = require('ora');
const chalk = require('chalk');
const chunk = require('lodash.chunk');

const log = console.log;

async function fetchGithubIssues(options) {
  const octokit = new Octokit({auth: options.githubToken});
  const [owner, repo] = options.githubUrl.split('/');
  const octokitOptions = octokit.issues.listForRepo.endpoint.merge({
    owner,
    repo,
    per_page: 100,
    state: options.state,
  });
  const data = await octokit.paginate(octokitOptions);
  return data.filter(issue => !issue.pull_request);
}

function getStoryType(labels) {
  if (labels.find(label => label.name.includes('bug'))) return 'bug';
  if (labels.find(label => label.name.includes('chore'))) return 'chore';
  return 'feature';
}


function getStory(project_id, {html_url, created_at, updated_at, labels, title, body}) {
  const story_type = getStoryType(labels);
  return {
    created_at,
    updated_at,
    story_type,
    name: title,
    description: body || '',
    external_id: html_url,
    project_id,
    labels: labels.map(label => ({
      color: `#${label.color}`,
      name: label.name
    }))
  };
}


async function createStories(options, stories) {
  const res = await fetch(`https://api.clubhouse.io/api/v2/stories/bulk?token=${options.clubhouseToken}`, {
    method: 'POST',
    body: JSON.stringify({stories}),
    headers: {
      'Content-Type': 'application/json'
    }
  });

  const body = await res.json();

  if (!res.ok) {
    throw new Error(`${res.statusText}:\n${JSON.stringify(body, null, 2)}`);
  }

  return body;
}

async function importIssuesToClubhouse(options, issues) {
  try {
    const clubhouse = Clubhouse.create(options.clubhouseToken);
    const project = await clubhouse.getProject(options.clubhouseProject);

    const stories = issues.map(issue => getStory(project.id, issue));
    const batches = chunk(stories, 10);

    let issuesImported = 0;
    await Promise.all(
      batches.map(async batch => {
        try {
          const added = await createStories(options, batch);
          issuesImported += added.length;
        } catch (e) {
          log(chalk.red(`Failed to import batch #${issue.number}: \n ${e.message}`));
        }
      })
    );

    return issuesImported


  } catch(error) {
    log(chalk.red(`Clubhouse Project ID ${options.clubhouseProject} could not be found`));
  }
}

function validateOptions(options) {
  let hasError = false;
  if (!options.githubToken) {
    hasError = true;
    log(chalk.red(`Usage: ${chalk.bold('--github-token')} arg is required`))
  }

  if (!options.clubhouseToken) {
    hasError = true;
    log(chalk.red(`Usage: ${chalk.bold('--clubhouse-token')} arg is required`))
  }

  if (!options.clubhouseProject) {
    hasError = true;
    log(
      chalk.red(`Usage: ${chalk.bold('--clubhouse-project')} arg is required`)
    )
  }

  if (!options.githubUrl) {
    hasError = true;
    log(chalk.red(`Usage: ${chalk.bold('--github-url')} arg is required`))
  }

  if (!['open', 'closed', 'all'].includes(options.state.toLowerCase())) {
    hasError = true;
    log(
      chalk.red(
        `Usage: ${chalk.bold('--state')} must be one of open | closed | all`
      )
    )
  }

  if (hasError) {
    log();
    process.exit(1);
  }
}

async function githubClubhouseImport(options) {
  validateOptions(options);
  let issues;
  const githubSpinner = ora('Retrieving issues from Github').start();
  try {
    issues =  await fetchGithubIssues(options);
    githubSpinner.succeed(`Retrieved ${chalk.bold(issues.length)} issues from Github`);
  } catch(err) {
    githubSpinner.fail(`Failed to fetch issues from ${chalk.underline(options.githubUrl)}\n`);
    log(chalk.red(err))
  }

  if (issues) {
    const clubhouseSpinner = ora('Importing issues into Clubhouse').start();
    const issuesImported = await importIssuesToClubhouse(options, issues);
    clubhouseSpinner.succeed(`Imported ${chalk.bold(issuesImported)} issues into Clubhouse`);
  }
}

module.exports.default = githubClubhouseImport;
