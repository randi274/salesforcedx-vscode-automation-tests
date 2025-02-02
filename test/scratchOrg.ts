/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import child_process from 'child_process';
import fs from 'fs';
import path from 'path';
import util from 'util';
import {
  DefaultTreeItem,
  InputBox,
  QuickOpenBox,
  Workbench
} from 'wdio-vscode-service';
import {
  EnvironmentSettings
} from './environmentSettings';
import * as utilities from './utilities';


const exec = util.promisify(child_process.exec);

export class ScratchOrg {
  private testSuiteSuffixName: string;
  private reuseScratchOrg = false;
  public tempFolderPath: string | undefined = undefined;
  public projectFolderPath: string | undefined = undefined;
  private prompt: QuickOpenBox | InputBox | undefined;
  private scratchOrgAliasName: string | undefined;

  public constructor(testSuiteSuffixName: string, reuseScratchOrg: boolean) {
    this.testSuiteSuffixName = testSuiteSuffixName;
    this.reuseScratchOrg = reuseScratchOrg;

    // To have all scratch orgs be reused, uncomment the following line:
    // this.reuseScratchOrg = true;
  }

  public get tempProjectName(): string {
    return 'TempProject-' + this.testSuiteSuffixName;
  }

  public async setUp(scratchOrgEdition: string = 'Developer'): Promise<void> {
    await this.setUpTestingEnvironment();
    await this.createProject(scratchOrgEdition);
    await this.authorizeDevHub();
    await this.createDefaultScratchOrg();
  }

  public async tearDown(): Promise<void> {
    if (this.scratchOrgAliasName && !this.reuseScratchOrg) {
      // To use VS Code's Terminal view to delete the scratch org, use:
      // const workbench = await (await browser.getWorkbench()).wait();
      // await utilities.executeCommand(workbench, `sfdx force:org:delete -u ${this.scratchOrgAliasName} --noprompt`);

      // The Terminal view can be a bit unreliable, so directly call exec() instead:
      await exec(`sfdx force:org:delete -u ${this.scratchOrgAliasName} --noprompt`);
    }

    // This used to work...
    // if (this.projectFolderPath) {
    //   await utilities.removeFolder(this.projectFolderPath);
    // }
    // ...but something recently changed and now, removing the folder while VS Code has the folder open
    // causes VS Code to get into a funky state.  The next time a project is created, we get the
    // following error:
    //   07:45:19.65 Starting SFDX: Create Project
    //   ENOENT: no such file or directory, uv_cwd
    //
    // Not deleting the folder that was created is OK, b/c it is deleted in setUpTestingEnvironment()
    // the next time the test suite runs.  I'm going to leave this in for now in case this gets fixed
    // and this code can be added back in.
  }

  public async setUpTestingEnvironment(): Promise<void> {
    utilities.log('');
    utilities.log(`${this.testSuiteSuffixName} - Starting setUpTestingEnvironment()...`);

    this.tempFolderPath = path.join(__dirname, '..', 'e2e-temp');
    this.projectFolderPath = path.join(this.tempFolderPath, this.tempProjectName);
    utilities.log(`${this.testSuiteSuffixName} - creating project files in ${this.projectFolderPath}`);

    // Remove the project folder, just in case there are stale files there.
    if (fs.existsSync(this.projectFolderPath)) {
      await utilities.removeFolder(this.projectFolderPath);
      await utilities.pause(1);
    }

    // Now create the temp folder.  It should exists but create the folder if it is missing.
    if (!fs.existsSync(this.tempFolderPath)) {
      await utilities.createFolder(this.tempFolderPath);
      await utilities.pause(1);
    }

    utilities.log(`${this.testSuiteSuffixName} - ...finished setUpTestingEnvironment()`);
    utilities.log('');
  }

  public async createProject(scratchOrgEdition: string): Promise<void> {
    utilities.log('');
    utilities.log(`${this.testSuiteSuffixName} - Starting createProject()...`);

    const workbench = await browser.getWorkbench();
    this.prompt = await utilities.runCommandFromCommandPrompt(workbench, 'SFDX: Create Project', 10);
    // Selecting "SFDX: Create Project" causes the extension to be loaded, and this takes a while.

    // Select the "Standard" project type.
    await utilities.selectQuickPickWithText(this.prompt, 'Standard');

    // Enter the project's name.
    await this.prompt.setText(this.tempProjectName);
    await utilities.pause(1);

    // Press Enter/Return.
    await this.prompt.confirm();

    // Set the location of the project.
    const input = await this.prompt.input$;
    await input.setValue(this.tempFolderPath!);
    await utilities.pause(1);

    // Click the OK button.
    await utilities.clickFilePathOkButton();

    // Verify the project was created and was loaded.
    const sidebar = await workbench.getSideBar();
    const content = await sidebar.getContent();
    const treeViewSection = await content.getSection(this.tempProjectName.toUpperCase());
    if (!treeViewSection) {
      throw new Error('In createProject(), getSection() returned a treeViewSection with a value of null (or undefined)');
    }

    const forceAppTreeItem = await treeViewSection.findItem('force-app') as DefaultTreeItem;
    if (!forceAppTreeItem) {
      throw new Error('In createProject(), findItem() returned a forceAppTreeItem with a value of null (or undefined)');
    }

    await forceAppTreeItem.expand();

    // Yep, we need to wait a long time here.
    await utilities.pause(10);

    if (scratchOrgEdition === 'Enterprise') {
      const projectScratchDefPath = path.join(this.tempFolderPath!, this.tempProjectName, 'config', 'project-scratch-def.json');
      let  projectScratchDef = fs.readFileSync(projectScratchDefPath, 'utf8');
      projectScratchDef = projectScratchDef.replace(`"edition": "Developer"`, `"edition": "Enterprise"`);
      fs.writeFileSync(projectScratchDefPath, projectScratchDef, 'utf8');
    }

    utilities.log(`${this.testSuiteSuffixName} - ...finished createProject()`);
    utilities.log('');
  }

  private async authorizeDevHub(): Promise<void> {
    utilities.log('');
    utilities.log(`${this.testSuiteSuffixName} - Starting authorizeDevHub()...`);

    // This is essentially the "SFDX: Authorize a Dev Hub" command, but using the CLI and an auth file instead of the UI.
    const authFilePath = path.join(this.projectFolderPath!, 'authFile.json');
    utilities.log(`${this.testSuiteSuffixName} - calling sfdx force:org:display...`);
    const sfdxForceOrgDisplayResult = await exec(`sfdx force:org:display -u ${EnvironmentSettings.getInstance().devHubAliasName} --verbose --json`);
    const json = this.removedEscapedCharacters(sfdxForceOrgDisplayResult.stdout);

    // Now write the file.
    fs.writeFileSync(authFilePath, json);
    utilities.log(`${this.testSuiteSuffixName} - finished writing the file...`);

    // Call auth:sfdxurl:store and read in the JSON that was just created.
    utilities.log(`${this.testSuiteSuffixName} - calling sfdx auth:sfdxurl:store...`);
    const sfdxSfdxUrlStoreResult = await exec(`sfdx auth:sfdxurl:store -d -f ${authFilePath}`);
    if (!sfdxSfdxUrlStoreResult.stdout.includes(`Successfully authorized ${EnvironmentSettings.getInstance().devHubUserName} with org ID`)) {
      throw new Error(`In authorizeDevHub(), sfdxSfdxUrlStoreResult does not contain "Successfully authorized ${EnvironmentSettings.getInstance().devHubUserName} with org ID"`);
    }

    utilities.log(`${this.testSuiteSuffixName} - ...finished authorizeDevHub()`);
    utilities.log('');
  }

  private async createDefaultScratchOrg(): Promise<void> {
    utilities.log('');
    utilities.log(`${this.testSuiteSuffixName} - Starting createDefaultScratchOrg()...`);

    const currentOsUserName = await utilities.transformedUserName();
    const workbench = await browser.getWorkbench();

    if (this.reuseScratchOrg) {
      utilities.log(`${this.testSuiteSuffixName} - looking for a scratch org to reuse...`);

      const sfdxForceOrgListResult = await exec('sfdx force:org:list --json');
      const resultJson = sfdxForceOrgListResult.stdout.replace(/\u001B\[\d\dm/g, '').replace(/\\n/g, '');
      const scratchOrgs = JSON.parse(resultJson).result.scratchOrgs;

      for (const scratchOrg of scratchOrgs) {
        const alias = scratchOrg.alias as string;
        if (alias && alias.includes('TempScratchOrg_') && alias.includes(currentOsUserName) && alias.includes(this.testSuiteSuffixName)) {
          this.scratchOrgAliasName = alias;

          // Set the current scratch org.
          await this.setDefaultOrg(workbench, this.scratchOrgAliasName);

          utilities.log(`${this.testSuiteSuffixName} - found one: ${this.scratchOrgAliasName}`);
          utilities.log(`${this.testSuiteSuffixName} - ...finished createDefaultScratchOrg()`);
          utilities.log('');
          return;
        }
      }
    }

    const definitionFile = path.join(this.projectFolderPath!, 'config', 'project-scratch-def.json');

    // Org alias format: TempScratchOrg_yyyy_mm_dd_username_ticks_testSuiteSuffixName
    const currentDate = new Date();
    const ticks = currentDate.getTime();
    const day = ('0' + currentDate.getDate()).slice(-2);
    const month = ('0' + (currentDate.getMonth() + 1)).slice(-2);
    const year = currentDate.getFullYear();
    this.scratchOrgAliasName = `TempScratchOrg_${year}_${month}_${day}_${currentOsUserName}_${ticks}_${this.testSuiteSuffixName}`;
    utilities.log(`${this.testSuiteSuffixName} - temporary scratch org name is ${this.scratchOrgAliasName}...`);

    const startDate = Date.now();
    const durationDays = 1;

    utilities.log(`${this.testSuiteSuffixName} - calling sfdx force:org:create...`);
    // const sfdxForceOrgCreateResult = await exec(`sfdx force:org:create edition=Enterprise -f ${definitionFile} --setalias ${this.scratchOrgAliasName} --durationdays ${durationDays} --setdefaultusername --json --loglevel fatal`);
    const sfdxForceOrgCreateResult = await exec(`sfdx force:org:create -f ${definitionFile} --setalias ${this.scratchOrgAliasName} --durationdays ${durationDays} --setdefaultusername --json --loglevel fatal`);
    const json = this.removedEscapedCharacters(sfdxForceOrgCreateResult.stdout);
    const result = JSON.parse(json).result;

    const endDate = Date.now();
    const time = endDate - startDate;
    utilities.log(`Creating ${this.scratchOrgAliasName} took ${time} ticks (${time/1000.0} seconds)`);

    if (!result.authFields) {
      throw new Error('In createDefaultScratchOrg(), result.authFields is null (or undefined)');
    }

    if (!result.authFields.accessToken) {
      throw new Error('In createDefaultScratchOrg(), result.authFields.accessToken is null (or undefined)');
    }

    if (!result.orgId) {
      throw new Error('In createDefaultScratchOrg(), result.orgId is null (or undefined)');
    }

    if (!result.scratchOrgInfo.SignupEmail) {
      throw new Error('In createDefaultScratchOrg(), result.scratchOrgInfo.SignupEmail is null (or undefined)');
    }

    // Run SFDX: Set a Default Org
    utilities.log(`${this.testSuiteSuffixName} - selecting SFDX: Set a Default Org...`);
    const inputBox = await utilities.runCommandFromCommandPrompt(workbench, 'SFDX: Set a Default Org', 1);

    // Select this.scratchOrgAliasName from the list.
    let scratchOrgQuickPickItemWasFound = false;
    const quickPicks = await inputBox.getQuickPicks();
    for (const quickPick of quickPicks) {
      const label = await quickPick.getLabel();
      // Find the org that was created.
      if (label.includes(this.scratchOrgAliasName)) {
        await quickPick.select();
        await utilities.pause(3);
        scratchOrgQuickPickItemWasFound = true;
        break;
      }
    }

    if (!scratchOrgQuickPickItemWasFound) {
      throw new Error(`In createDefaultScratchOrg(), the scratch org's pick list item was not found`);
    }
    // Warning! This only works if the item (the scratch org) is visible.
    // If there are many scratch orgs, not all of them may be displayed.
    // If lots of scratch orgs are created and aren't deleted, this can
    // result in this list growing one not being able to find the org
    // they are looking for.

    // Look for the success notification.
    const successNotificationWasFound = await utilities.notificationIsPresent(workbench, 'SFDX: Set a Default Org successfully ran');
    if (!successNotificationWasFound) {
      throw new Error('In createDefaultScratchOrg(), the notification of "SFDX: Set a Default Org successfully ran" was not found');
    }

    // Look for this.scratchOrgAliasName in the list of status bar items.
    const statusBar = await workbench.getStatusBar();
    const scratchOrgStatusBarItem = await utilities.getStatusBarItemWhichIncludes(statusBar, this.scratchOrgAliasName);
    if (!scratchOrgStatusBarItem) {
      throw new Error('In createDefaultScratchOrg(), getStatusBarItemWhichIncludes() returned a scratchOrgStatusBarItem with a value of null (or undefined)');
    }

    utilities.log(`${this.testSuiteSuffixName} - ...finished createDefaultScratchOrg()`);
    utilities.log('');
  }

  private async setDefaultOrg(workbench: Workbench, scratchOrgAliasName: string): Promise<void> {
    const inputBox = await utilities.runCommandFromCommandPrompt(workbench, 'SFDX: Set a Default Org', 2);

    let scratchOrgQuickPickItemWasFound = false;

    const currentOsUserName = await utilities.transformedUserName();
    await utilities.pause(1);

    const quickPicks = await inputBox.getQuickPicks();
    await utilities.pause(1);

    for (const quickPick of quickPicks) {
      const label = await quickPick.getLabel();
      if (scratchOrgAliasName) {
        // Find the org that was created in the "Run SFDX: Create a Default Scratch Org" step.
        if (label.includes(scratchOrgAliasName)) {
          await quickPick.select();
          await utilities.pause(3);
          scratchOrgQuickPickItemWasFound = true;
          break;
        }
      } else {
        // If the scratch org was already created (and not deleted),
        // and the "Run SFDX: Create a Default Scratch Org" step was skipped,
        // scratchOrgAliasName is undefined and as such, search for the first org
        // that starts with "TempScratchOrg_" and also has the current user's name.
        if (label.startsWith('TempScratchOrg_') && label.includes(currentOsUserName)) {
          scratchOrgAliasName = label.split(' - ')[0];
          await quickPick.select();
          await utilities.pause(3);
          scratchOrgQuickPickItemWasFound = true;
          break;
        }
      }
    }

    if (!scratchOrgQuickPickItemWasFound) {
      throw new Error(`In setDefaultOrg(), the scratch org's quick pick item was not found`);
    }

    const successNotificationWasFound = await utilities.notificationIsPresent(workbench, 'SFDX: Set a Default Org successfully ran');
    if (!successNotificationWasFound) {
      throw new Error('In setDefaultOrg(), the notification of "SFDX: Set a Default Org successfully ran" was not found');
    }

    // Look for orgAliasName in the list of status bar items
    const statusBar = await workbench.getStatusBar();
    const scratchOrgStatusBarItem = await utilities.getStatusBarItemWhichIncludes(statusBar, scratchOrgAliasName);
    if (!scratchOrgStatusBarItem) {
      throw new Error('In setDefaultOrg(), getStatusBarItemWhichIncludes() returned a scratchOrgStatusBarItem with a value of null (or undefined)');
    }
  }

  private removedEscapedCharacters(stdout: string): string {
    // When calling exec(), the JSON returned contains escaped characters.
    // Removed the extra escaped characters and carriage returns.
    const resultJson = stdout.replace(/\u001B\[\d\dm/g, '').replace(/\\n/g, '');

    return resultJson;
  }
}
