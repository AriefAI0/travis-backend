// Every report template sits in the repo-root templates/ folder.
// flow: name > URL resolved from this file, so cwd never matters
export const templatesDir = (name: string) =>
  new URL(`../../../templates/${name}`, import.meta.url);
