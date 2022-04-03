# Contributing to @pcordjs/rest

Thanks for taking the time to help this project improve! All contributions are
helpful and welcome.

## Table of Contents

- [Contributing to @pcordjs/rest](#contributing-to-pcordjsrest)
  - [Table of Contents](#table-of-contents)
  - [I have a question!](#i-have-a-question)
  - [Ways to contribute](#ways-to-contribute)
    - [Reporting a problem](#reporting-a-problem)
      - [If you find an issue that describes the same problem](#if-you-find-an-issue-that-describes-the-same-problem)
      - [Reporting a typo](#reporting-a-typo)
      - [Writing and submitting your report](#writing-and-submitting-your-report)
    - [Suggesting features](#suggesting-features)
      - [If you find an issue that suggests your idea](#if-you-find-an-issue-that-suggests-your-idea)
      - [Writing and submitting your suggestion](#writing-and-submitting-your-suggestion)
    - [Contributing code](#contributing-code)
      - [Node.js packages](#nodejs-packages)
      - [Project structure](#project-structure)
      - [Code styleguide](#code-styleguide)
      - [Variable name styleguide](#variable-name-styleguide)
      - [Unit tests](#unit-tests)
      - [Pull requests](#pull-requests)

## I have a question!

If you just have a question about the library or need help, the best way you can
get support is by creating a post in the [Q&A Discussions
category](https://github.com/pcordjs/rest/discussions/categories/q-a).

## Ways to contribute

### Reporting a problem

If something is not working as expected, you can use the repository's
[Issues][issues-page] page to report it. Before
creating a bug report, use the search bar to make sure that what you're
experiencing isn't already a known issue.

#### If you find an issue that describes the same problem

If the issue you found is *closed*, it's fine to make a new one, but make sure
to **link the one you found** under the **Additional information** header.

However, if the issue you found is *open*, the best way to help is by leaving a
comment on it, describing your experience.

#### Reporting a typo

If the problem you're reporting is a typo or a just a simple mistake, you may
want to use the **Small issue** template in the next step.

#### Writing and submitting your report

When creating your report, you should use the **Bug report** issue template to
be provided with a list of questions that will help describe the problem you are
having.

Additionally, try to do the following:

- Give the issue a **clear and concise** title.
- Fill out **as many of the template's headers as possible**.
- Provide a **code sample** to help readers reproduce the issue.
- Provide your Node.js version, and operating system.
- Attach **screenshots or GIFs** to help display the problem.
- Explain **when the problem started happening**. Was it after a recent update?
  Or has it always been happening?

### Suggesting features

First of all, thanks for wanting to share your idea! Feature requests help this
project grow.

Before submitting your suggestion, remember to consider the following:

- Your idea may have already been discussed. Use the [Issues][issues-page]
  search bar to see if there are any similar suggestions.
- Your idea should be within the project's scope. The goal of this project is to
  provide a flexible, low-level HTTPS client for [Discord's REST
  API][discord-docs].

#### If you find an issue that suggests your idea

If the issue is *open,* send it a :+1: emoji! If it's closed, it's possible it
has already been implemented or was denied.

#### Writing and submitting your suggestion

When creating your report, you should use the **Feature request** issue template
to be provided with a list of questions that will help describe the suggestion
you are submitting.

Additionally, try to do the following:

- Give the issue a **clear and concise** title.
- Fill out **as many of the template's headers as possible**.
- Provide **code samples, screenshots, or GIFs** to help readers understand what
  you're saying.
- Consider **how the suggestion would be implemented**. Try to think of at least
  2 different ways!


### Contributing code

The simplest way to start contributing code to @pcordjs/rest is by finding an
[Issue][issues-page] to tackle. Each one requests changes to the project, and some are
more involved than others. Issues with the [good first
issue][first-issue-search] label are good candidates for your first
contribution.

When you're ready to start coding, **fork the project**, then use `git clone` or `gh clone` to clone the repository.

#### Node.js packages

All pcordjs projects use [pnpm][pnpm-website] for managing packages. Please
don't introduce lock-files from other package managers (`package-lock.json`,
`yarn.lock`) in your contributions! You can install pnpm via the script on
[their homepage][pnpm-website].

**If the script that installs pnpm fails**, you should try putting the following
line in `.npmrc` (usually stored in your home directory):

```ini
prefix=${HOME}/.local/pnpm
```

After installing the packages needed for development, you can use `pnpm
<command>` to run scripts and binaries (e.g. `pnpm build`, `pnpm jest`).

#### Project structure

- `.github/`: CI workflows & issue/pull request templates
- `.husky/`: [Husky][husky-website] Git hooks
- `src/`: Project source code
- `.commitlintrc.json`: Configures [commitlint][commitlint-website]
- `.eslintrc.json`: Configures [ESLint][eslint-website]
- `.lintstagedrc.mjs`: Configures [lint-staged][lint-staged-website]
- `jest.config.ts`: Configures [Jest][jest-website] unit tests
- `tsconfig.json`: Configures [TypeScript][typescript-website] build options
- `tsconfig.eslint.json`: Modified TSConfig options for ESLint

#### Code styleguide

All TypeScript should be formatted with [Prettier][prettier-website], using the
following configuration:

```json
{
  "singleQuote": true,
  "trailingComma": "none"
}
```

- Prefer the object spread operator `({...anotherObj})` to `Object.assign()`.
- Inline `export`s whenever possible.
  ```js
  // Use this:
  export default class ClassName {}
  // Instead of:
  class ClassName {}
  export default ClassName;
  ```
- Use [TSDoc][tsdoc-website] when writing documentation.

#### Variable name styleguide

Classes, enums, interfaces, type definitions, and namespaces should use the
PascalCase naming style (e.g. `Path2D`, `TypeError`, `RESTClient`). Variables
and functions should use the camelCase naming style (e.g. `message`,
`userAgent`, `finalizeRequest`).

When writing camelCase names, acronyms should be uppercase *unless* they are the
first word in the name: `urlBucket` and `targetURL` are both correct.

#### Unit tests

@pcordjs/rest uses [Jest][jest-website] for unit tests. Tests should go in `src/*.test.ts` files, and failing tests may cause your pull request to be blocked from merging. If tests are failing but you believe that they are not related to your changes, leave a comment on your pull request explaining that.

When writing bug fixes, it is a good idea to write unit test(s) to enforce that the bug will stay fixed through future changes. When writing a new feature, consider writing unit tests to ensure that it works as intended.

#### Pull requests

When you're ready for your changes to be merged, head over to the [Pull
Requests][pr-page] page and create a new pull request. Include a description of
what changed, and [link to an Issue][link-to-issue-guide] if applicable.

If you're not quite done with the changes but are looking for feedback, you can
[mark it as a draft][about-draft-prs] to prevent it from being merged.

Once your pull request has been merged, congrats! Your changes will be mentioned
in the next release's changelog and, if you'd like, you will be added to the
`contributors` field in `package.json`.

[issues-page]: https://github.com/pcordjs/rest/issues
[pr-page]: https://github.com/pcordjs/rest/pulls
[first-issue-search]:
    https://github.com/pcordjs/rest/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22
[pnpm-website]: https://pnpm.io
[husky-website]: https://typicode.github.io/husky
[commitlint-website]: https://commitlint.js.org
[eslint-website]: https://eslint.org
[lint-staged-website]: https://github.com/okonet/lint-staged
[jest-website]: https://jestjs.io
[typescript-website]: https://typescriptlang.org
[prettier-website]: https://prettier.io
[tsdoc-website]: https://tsdoc.org
[link-to-issue-guide]:
    https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
[about-draft-prs]:
    https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests#draft-pull-requests
[atom-contributing]: https://github.com/atom/atom/blob/master/CONTRIBUTING.md
[discord-docs]: https://discord.com/developers/docs/reference
