// main.ts

import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile, normalizePath } from 'obsidian';

// Plugin settings
interface AddBookSettings {
  templatePath: string;  // Path to template file (e.g., 'templates/book-template.md')
  saveFolder: string;    // Path to save folder (e.g., 'Books/')
  openAfterCreate: boolean; // Whether to open the note after creation
}

const DEFAULT_SETTINGS: AddBookSettings = {
  templatePath: '',
  saveFolder: '',
  openAfterCreate: true
};

interface BookData {
  title: string;
  author: string;
  pages: string;
  cover: string;
}

export default class AddBookPlugin extends Plugin {
  settings: AddBookSettings;

  async onload() {
    await this.loadSettings();

    // Add ribbon icon
    const ribbonIconEl = this.addRibbonIcon('book-down', 'Add Book from URL', (_evt: MouseEvent) => {
      this.addBook();
    });
    ribbonIconEl.addClass('add-book-plugin-ribbon-class');

    // Add command to run the plugin
    this.addCommand({
      id: 'add-book-from-url',
      name: 'Add Book from URL',
      callback: () => this.addBook(),
    });

    // Add settings tab
    this.addSettingTab(new AddBookSettingTab(this.app, this));
  }

  async onunload() {
    // Cleanup if needed
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Main function to add book
  async addBook() {
    new UrlInputModal(this.app, async (url: string) => {
      if (!url) {
        new Notice('❌ No URL entered', 5000);
        return;
      }

      const source = this.detectSource(url);
      if (!source) {
        new Notice(`⚠️ Site not supported. URL must be from one of the following:\n- Taaghche\n- Fidibo\n- Behkhaan`, 5000);
        return;
      }

      const bookData = await this.fetchBookData(url, source);
      if (!bookData) {
        new Notice('❌ Error fetching data. Check internet, VPN, or URL.', 5000);
        return;
      }

      // Read template (use default if not specified)
      let templateContent: string = '';
      if (this.settings.templatePath) {
        let templatePath = this.settings.templatePath;
        if (!templatePath.endsWith('.md')) {
          templatePath += '.md';
        }
        templatePath = normalizePath(templatePath);
        const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
        if (templateFile && templateFile instanceof TFile) {
          templateContent = await this.app.vault.read(templateFile);
        } else {
          new Notice('⚠️ Template not found. Using default.', 5000);
        }
      }

      // If template is empty, use default content
      if (!templateContent) {
        templateContent = `---
title: "{{title}}"
author: "{{author}}"
pages: {{pages}}
cover: "{{cover}}"
---

`;
      }

      // Replace placeholders in template
      let noteContent: string = templateContent
        .replace(/{{title}}/g, bookData.title)
        .replace(/{{author}}/g, bookData.author)
        .replace(/{{pages}}/g, bookData.pages)
        .replace(/{{cover}}/g, bookData.cover);

      // Create unique filename
      const cleanTitle: string = bookData.title.replace(/[\\/:*?"<>|]/g, "");
      const uniqueFilename: string = await this.getUniqueFilename(cleanTitle, this.settings.saveFolder);

      // Create new file
      const filePath: string = normalizePath(`${this.settings.saveFolder}${uniqueFilename}.md`);
      const newFile = await this.app.vault.create(filePath, noteContent);
      new Notice(`✅ New note created: ${uniqueFilename}.md`, 5000);

      // Open the new note if the setting is enabled
      if (this.settings.openAfterCreate) {
        await this.app.workspace.getLeaf().openFile(newFile);
      }
    }).open();
  }

  // Detect source function (from original code)
  detectSource(url: string): string | null {
    const patterns: { [key: string]: RegExp } = {
      taaghche: /taaghche\.com\/book\//i,
      fidibo: /fidibo\.com\/(books|book)\//i,
      behkhaan: /behkhaan\.ir\/books\//i
    };
    const match = Object.entries(patterns).find(([_, pattern]) => pattern.test(url));
    return match ? match[0] : null;
  }

  // Fetch book data function (with requestUrl)
  async fetchBookData(url: string, source: string): Promise<BookData | null> {
    try {
      const response = await requestUrl({
        url,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const html: string = response.text;
      const doc: Document = new DOMParser().parseFromString(html, 'text/html');

      // Extraction for each source (from original add-book.js, adapted for TS)
      if (source === 'taaghche') {
        let pages: string = 'Unknown';
        const infoElements = doc.querySelectorAll('div.moreInfo_info__BE9J3');
        
        Array.from(infoElements).forEach((el) => {
          const keyElement = el.querySelector('p.moreInfo_key__WX6Qk');
          if (keyElement) {
            const keyText: string = keyElement.textContent?.trim() || '';
            
            if (/تعداد\s*صفحه/i.test(keyText)) {
              const valueElement = el.querySelector('p.moreInfo_value__ctk9e');
              if (valueElement) {
                const persianNumbers: string[] = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
                let valueText: string = valueElement.textContent?.trim() || '';
                
                persianNumbers.forEach((num, index) => {
                  valueText = valueText.replace(new RegExp(num, 'g'), index.toString());
                });
                
                const pageMatch = valueText.match(/\d+/);
                if (pageMatch) {
                  pages = pageMatch[0];
                }
              }
            }
          }
        });
        return {
          title: doc.querySelector("h1")?.textContent?.trim() || "Unknown",
          author: doc.querySelector("a[href*='/author/']")?.textContent?.trim() || "Unknown",
          pages: pages,
          cover: doc.querySelector("#book-image")?.getAttribute("src")?.replace(/\?.*$/, "") || ""
        };
      } else if (source === 'fidibo') {
        const titleElement = doc.querySelector('h1.book-main-box-detail-title');
        const authorRow = Array.from(doc.querySelectorAll('tr.book-vl-rows-item'))
          .find(row => row.querySelector('td.book-vl-rows-item-title')?.textContent?.includes("نویسنده"));
        const pagesRow = Array.from(doc.querySelectorAll('tr.book-vl-rows-item'))
          .find(row => row.querySelector('td.book-vl-rows-item-title')?.textContent?.includes("تعداد صفحات"));
        
        return {
          title: titleElement?.textContent?.trim() || "Unknown",
          author: authorRow?.querySelector('a.book-vl-rows-item-subtitle, div.book-vl-rows-item-subtitle')?.textContent?.trim() || "Unknown",
          pages: pagesRow?.querySelector('div.book-vl-rows-item-subtitle')?.textContent?.match(/\d+/)?.[0] || "Unknown",
          cover: doc.querySelector('img.book-main-box-img')?.getAttribute("src")?.split('?')[0] || ""
        };
      } else if (source === 'behkhaan') {
        const title: string = doc.querySelector('h1#title')?.textContent?.trim() || "Unknown";
      
        const authorElement = doc.querySelector('div.w-full.my-2 span.text-sm.md\\:text-base.text-gray-500');
        const author: string = authorElement?.textContent?.trim() || "Unknown";
        
        const pagesLabel = Array.from(doc.querySelectorAll('span.text-xs.md\\:text-sm.text-gray-500'))
          .find(el => el.textContent?.includes("تعداد صفحات"));
        let pages: string = "Unknown";
        if (pagesLabel) {
          const pagesElement = pagesLabel.parentElement?.nextElementSibling;
          if (pagesElement) {
            const persianNumbers: string[] = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
            let pagesText: string = pagesElement.textContent?.trim() || '';
            persianNumbers.forEach((num, index) => {
              pagesText = pagesText.replace(new RegExp(num, 'g'), index.toString());
            });
            const pageMatch = pagesText.match(/\d+/);
            pages = pageMatch ? pageMatch[0] : "Unknown";
          }
        }
        
        let cover: string = doc.querySelector('img.w-full.h-full.object-cover.rounded-lg.cursor-pointer')?.getAttribute("src") || "";
        if (cover && !cover.startsWith("http")) {
          cover = `https://behkhaan.ir${cover}`;
        }
      
        return {
          title: title,
          author: author,
          pages: pages,
          cover: cover
        };
      }

      return null;
    } catch (error) {
      new Notice(`Error fetching ${source}: ${(error as Error).message}`, 5000);
      return null;
    }
  }

  // Unique filename function (adapted)
  async getUniqueFilename(baseName: string, folder: string): Promise<string> {
    folder = normalizePath(folder);
    let counter: number = 1;
    let newName: string = baseName;
    const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folder));

    while (files.some(file => file.basename === newName)) {
      newName = `${baseName} ${counter}`;
      counter++;
    }
    return newName;
  }
}

// Modal for URL input
class UrlInputModal extends Modal {
  onSubmit: (url: string) => void;
  input: HTMLInputElement;

  constructor(app: App, onSubmit: (url: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Enter book URL' });

    this.input = contentEl.createEl('input', { type: 'text', cls: 'add-book-url-input' });
    this.input.focus();

    const buttonContainer = contentEl.createEl('div', { cls: 'add-book-button-container' });
    const button = buttonContainer.createEl('button', { text: 'Submit', cls: 'add-book-submit-button' });
    button.onClickEvent(() => {
      this.onSubmit(this.input.value);
      this.close();
    });

    // Handle Enter key
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.onSubmit(this.input.value);
        this.close();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Settings tab class
class AddBookSettingTab extends PluginSettingTab {
  plugin: AddBookPlugin;

  constructor(app: App, plugin: AddBookPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Setting for template path
    new Setting(containerEl)
      .setName('Template note path')
      .setDesc('Path to the template note. If empty, uses default template.')
      .addText(text => text
        .setPlaceholder('templates/book-template')
        .setValue(this.plugin.settings.templatePath.replace(/\.md$/, ''))
        .onChange(async (value) => {
          if (value && !value.endsWith('.md')) {
            value += '.md';
          }
          this.plugin.settings.templatePath = normalizePath(value);
          await this.plugin.saveSettings();
        }));

    // Setting for save folder
    new Setting(containerEl)
      .setName('Save folder path')
      .setDesc('Folder to save new notes. If empty, saves to root.')
      .addText(text => text
        .setPlaceholder('Books/')
        .setValue(this.plugin.settings.saveFolder)
        .onChange(async (value) => {
          let normalized = normalizePath(value);
          this.plugin.settings.saveFolder = normalized.endsWith('/') ? normalized : normalized + '/';
          await this.plugin.saveSettings();
        }));

    // Setting for opening note after creation
    new Setting(containerEl)
      .setName('Open note after creation')
      .setDesc('Automatically open the newly created note.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.openAfterCreate)
        .onChange(async (value) => {
          this.plugin.settings.openAfterCreate = value;
          await this.plugin.saveSettings();
        }));
  }
}