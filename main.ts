// main.ts

import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile, TFolder, normalizePath, AbstractInputSuggest, TextComponent, TAbstractFile } from 'obsidian';

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
  publisher?: string;
  translator?: string;
  datepublished?: string;
  language?: string;
  url?: string;
}

export default class AddBookPlugin extends Plugin {
  settings: AddBookSettings;

  async onload() {
    await this.loadSettings();

    // Add ribbon icon
    const ribbonIconEl = this.addRibbonIcon('book-down', 'Add book from link.', (_evt: MouseEvent) => {
      void this.addBook();
    });
    ribbonIconEl.addClass('add-book-plugin-ribbon-class');

    // Add command to run the plugin
    this.addCommand({
      id: 'add-book-from-url',
      name: 'Add book from link.',
      callback: () => this.addBook(),
    });

    // Add settings tab
    this.addSettingTab(new AddBookSettingTab(this.app, this));
  }

  onunload(): void {
    // Cleanup if needed
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Helper function to check if a folder path is root
  private isRootFolder(folderPath: string): boolean {
    const normalized = normalizePath(folderPath.replace(/\/$/, ''));
    return normalized === '' || normalized === '/';
  }

  // Main function to add book
  async addBook() {
    const modal = new UrlInputModal(this.app);
    modal.open();
    
    const url = await modal.promise;
    
    if (!url) {
      new Notice('Please enter a link.', 5000);
      return;
    }

    const source = this.detectSource(url);
    if (!source) {
      new Notice(`This site is not supported.`, 5000);
      return;
    }

    const bookData = await this.fetchBookData(url, source);
    if (!bookData) {
      new Notice('Failed to fetch data.', 5000);
      return;
    }

    // Read template (use default if not specified)
    let templateContent: string = '';
    if (this.settings.templatePath) {
      const templatePath = normalizePath(this.settings.templatePath);
      
      const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
      if (templateFile && templateFile instanceof TFile) {
        templateContent = await this.app.vault.read(templateFile);
      } else {
        new Notice('Template not found. Using default.', 5000);
      }
    }

    // If template is empty, use default content
    if (!templateContent) {
      templateContent = `---
title: "{{title}}"
author: "{{author}}"
translator: "{{translator}}"
pages: {{pages}}
cover: "{{cover}}"
publisher: "{{publisher}}"
datepublished: "{{datepublished}}"
url: "{{url}}"
language: "{{language}}"
---

`;
    }

    // Replace placeholders in template
    let noteContent: string = templateContent
      .replace(/{{title}}/g, bookData.title)
      .replace(/{{author}}/g, bookData.author)
      .replace(/{{pages}}/g, bookData.pages)
      .replace(/{{cover}}/g, bookData.cover)
      .replace(/{{publisher}}/g, bookData.publisher || '')
      .replace(/{{translator}}/g, bookData.translator || '')
      .replace(/{{datepublished}}/g, bookData.datepublished || '')
      .replace(/{{url}}/g, bookData.url || '')
      .replace(/{{language}}/g, bookData.language || '');
    
    // Validate save folder path if specified (skip validation for root folder)
    if (this.settings.saveFolder && !this.isRootFolder(this.settings.saveFolder)) {
      // Normalize and remove trailing slash
      const folderPath = normalizePath(this.settings.saveFolder.replace(/\/$/, ''));
      
      // Check if the specified folder exists
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (!folder || !(folder instanceof TFolder)) {
        new Notice('Save folder not found. Please set a valid path in settings.', 5000);
        return;
      }
    }
    
    // Create unique filename
    const cleanTitle: string = bookData.title.replace(/[\\/:*?"<>|]/g, "");
    const uniqueFilename: string = this.getUniqueFilename(cleanTitle, this.settings.saveFolder);
    
    // Create new file
    const filePath: string = normalizePath(`${this.settings.saveFolder}/${uniqueFilename}.md`);
    const newFile = await this.app.vault.create(filePath, noteContent);
    new Notice(`New note created: ${uniqueFilename}.md`, 5000);

    // Open the new note if the setting is enabled
    if (this.settings.openAfterCreate) {
      await this.app.workspace.getLeaf().openFile(newFile);
    }
  }

  // Detect source function (from original code)
  detectSource(url: string): string | null {
    const patterns: { [key: string]: RegExp } = {
      taaghche: /taaghche\.com\/book\//i,
      fidibo: /fidibo\.com\/(books|book)\//i,
      goodreads: /goodreads\.com\/book\/show\//i,
      amazon: /amazon\.com\/([a-zA-Z0-9-]+)\/dp\//i,
      behkhaan: /behkhaan\.ir\/books\//i
    };
    const match = Object.entries(patterns).find(([_, pattern]) => pattern.test(url));
    return match ? match[0] : null;
  }

  // Helper function to extract JSON-LD data from HTML
  private extractJsonLd(html: string): any | null {
    try {
      const doc: Document = new DOMParser().parseFromString(html, 'text/html');
      const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
      
      for (const script of Array.from(jsonLdScripts)) {
        try {
          const jsonData = JSON.parse(script.textContent || '');
          // Check if it's a Book or Product type
          if (jsonData['@type'] === 'Book' || 
              (Array.isArray(jsonData['@type']) && 
               (jsonData['@type'].includes('Book') || jsonData['@type'].includes('Product')))) {
            return jsonData;
          }
        } catch (e) {
          // Skip invalid JSON
          continue;
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  // Helper function to concatenate author names
  private concatenateAuthors(authors: any[]): string {
    if (!authors || !Array.isArray(authors) || authors.length === 0) {
      return '';
    }
    return authors
      .map((author: any) => {
        if (typeof author === 'string') {
          return author;
        } else if (author && typeof author === 'object' && author.name) {
          return author.name;
        }
        return '';
      })
      .filter((name: string) => name.trim() !== '')
      .join(', ') || '';
  }

  // Helper function to extract __NEXT_DATA__ from HTML
  private extractNextData(html: string): any | null {
    try {
      const doc: Document = new DOMParser().parseFromString(html, 'text/html');
      const nextDataScript = doc.querySelector('script#__NEXT_DATA__');
      
      if (nextDataScript && nextDataScript.textContent) {
        return JSON.parse(nextDataScript.textContent);
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  // Helper function to convert timestamp (milliseconds) to yyyy-mm-dd format
  private formatDateFromTimestamp(timestamp: number): string {
    if (!timestamp || isNaN(timestamp)) {
      return '';
    }
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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
        const jsonLd = this.extractJsonLd(html);
        if (jsonLd) {
          const workExample = jsonLd.workExample || jsonLd;
          const authors = jsonLd.author || [];
          const author = this.concatenateAuthors(authors);
          
          let translator = '';
          if (workExample.translator && Array.isArray(workExample.translator)) {
            translator = this.concatenateAuthors(workExample.translator);
          }

          // Extract canonical URL
          const canonicalLink = doc.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
          const canonicalUrl = canonicalLink?.getAttribute('href')?.trim() || url;
          
          return {
            title: jsonLd.name || '',
            author: author,
            pages: workExample.numberOfPages ? String(workExample.numberOfPages) : '',
            cover: jsonLd.image || '',
            publisher: workExample.publisher?.name || '',
            translator: translator || '',
            datepublished: workExample.datePublished || '',
            language: workExample.inLanguage || '',
            url: canonicalUrl
          };
        }
        return null;

      } else if (source === 'fidibo') {
        const titleElement = doc.querySelector('h1.book-main-box-detail-title');
        const authorRow = Array.from(doc.querySelectorAll('tr.book-vl-rows-item'))
          .find(row => row.querySelector('td.book-vl-rows-item-title')?.textContent?.includes("نویسنده"));
        const pagesRow = Array.from(doc.querySelectorAll('tr.book-vl-rows-item'))
          .find(row => row.querySelector('td.book-vl-rows-item-title')?.textContent?.includes("تعداد صفحات"));
        const publisherRow = Array.from(doc.querySelectorAll('tr.book-vl-rows-item'))
          .find(row => row.querySelector('td.book-vl-rows-item-title')?.textContent?.includes("ناشر"));
        const translatorRow = Array.from(doc.querySelectorAll('tr.book-vl-rows-item'))
          .find(row => row.querySelector('td.book-vl-rows-item-title')?.textContent?.includes("مترجم"));
        const datePublishedRow = Array.from(doc.querySelectorAll('tr.book-vl-rows-item'))
          .find(row => row.querySelector('td.book-vl-rows-item-title')?.textContent?.includes("تاریخ انتشار"));
        const languageRow = Array.from(doc.querySelectorAll('tr.book-vl-rows-item'))
          .find(row => row.querySelector('td.book-vl-rows-item-title')?.textContent?.includes("زبان"));

        // Fidibo does not expose canonical or og:url; fall back to the requested URL
        const fidiboUrl = url;
        
        return {
          title: titleElement?.textContent?.trim() || '',
          author: authorRow?.querySelector('a.book-vl-rows-item-subtitle, div.book-vl-rows-item-subtitle')?.textContent?.trim() || '',
          pages: pagesRow?.querySelector('div.book-vl-rows-item-subtitle')?.textContent?.match(/\d+/)?.[0] || '',
          cover: doc.querySelector('img.book-main-box-img')?.getAttribute("src")?.split('?')[0] || '',
          publisher: publisherRow?.querySelector('a.book-vl-rows-item-subtitle, div.book-vl-rows-item-subtitle')?.textContent?.trim() || '',
          translator: translatorRow?.querySelector('a.book-vl-rows-item-subtitle, div.book-vl-rows-item-subtitle')?.textContent?.trim() || '',
          datepublished: datePublishedRow?.querySelector('a.book-vl-rows-item-subtitle, div.book-vl-rows-item-subtitle')?.textContent?.trim() || '',
          language: languageRow?.querySelector('a.book-vl-rows-item-subtitle, div.book-vl-rows-item-subtitle')?.textContent?.trim() || '',
          url: fidiboUrl
        };
      } else if (source === 'goodreads') {
        // Extract from JSON-LD
        const jsonLd = this.extractJsonLd(html);
        if (jsonLd) {
          // Extract authors
          const authors = jsonLd.author || [];
          const author = this.concatenateAuthors(authors);
          
          // Extract publisher and datepublished from __NEXT_DATA__
          let publisher = '';
          let datepublished = '';
          const nextData = this.extractNextData(html);
          
          if (nextData) {
            // Recursive search for BookDetails object
            const findBookDetails = (obj: any, visited: Set<any> = new Set()): any => {
              if (!obj || typeof obj !== 'object' || visited.has(obj) || 
                  obj instanceof Date || obj instanceof RegExp || typeof obj === 'function') {
                return null;
              }
              visited.add(obj);
              
              // Check if this is a BookDetails object
              const isBookDetails = obj.__typename === 'BookDetails' || 
                (obj.publisher !== undefined && obj.publicationTime !== undefined && 
                 (obj.format !== undefined || obj.numPages !== undefined || obj.asin !== undefined));
              
              if (isBookDetails) return obj;
              if (obj.details && typeof obj.details === 'object') {
                const detailsResult = findBookDetails(obj.details, visited);
                if (detailsResult) return detailsResult;
              }
              
              // Search nested objects
              const items = Array.isArray(obj) ? obj : Object.values(obj);
              for (const item of items) {
                const result = findBookDetails(item, visited);
                if (result) return result;
              }
              return null;
            };
            
            // Search in common locations
            const details = findBookDetails(nextData?.props?.pageProps?.apolloState) ||
                          findBookDetails(nextData?.props?.pageProps) ||
                          findBookDetails(nextData?.props) ||
                          findBookDetails(nextData);
            
            if (details) {
              publisher = details.publisher ? String(details.publisher).trim() : '';
              datepublished = details.publicationTime ? this.formatDateFromTimestamp(details.publicationTime) : '';
            }
          }

          // Extract canonical URL
          const canonicalLink = doc.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
          const canonicalUrl = canonicalLink?.getAttribute('href')?.trim() || url;
          
          return {
            title: jsonLd.name || '',
            author: author,
            pages: jsonLd.numberOfPages ? String(jsonLd.numberOfPages) : '',
            cover: jsonLd.image || '',
            publisher: publisher,
            translator: '',
            datepublished: datepublished,
            language: jsonLd.inLanguage || '',
            url: canonicalUrl
          };
        }
        
        // JSON-LD not found
        return null;
      } else if (source === 'amazon') {
        const title: string = doc.querySelector('span#productTitle')?.textContent?.trim() || '';
        
        // Extract authors and translators from bylineInfo
        const bylineInfo = doc.querySelector('div#bylineInfo');
        const authors: string[] = [];
        const translators: string[] = [];
        
        if (bylineInfo) {
          const authorSpans = bylineInfo.querySelectorAll('span.author');
          authorSpans.forEach((span) => {
            const nameElement = span.querySelector('a.a-link-normal');
            const contributionElement = span.querySelector('span.contribution span.a-color-secondary');
            
            if (nameElement) {
              const name = nameElement.textContent?.trim() || '';
              const contribution = contributionElement?.textContent?.trim() || '';
              
              if (name) {
                if (contribution.includes('Translator')) {
                  translators.push(name);
                } else if (contribution.includes('Author') || contribution === '') {
                  // Include as author if marked as Author or if no contribution specified (defaults to author)
                  authors.push(name);
                }
              }
            }
          });
        }
        
        // Fallback to old method if bylineInfo not found
        let author: string = authors.length > 0 ? authors.join(', ') : '';
        if (author === '') {
          const authorElement = doc.querySelector('span.author a.a-link-normal');
          author = authorElement?.textContent?.trim() || '';
        }
        
        const translator: string = translators.length > 0 ? translators.join(', ') : '';
        
        const pagesElement = doc.querySelector('div.rpi-attribute-value span');
        let pages: string = '';
        if (pagesElement) {
          const pagesText: string = pagesElement.textContent?.trim() || '';
          const pageMatch = pagesText.match(/\d+/);
          pages = pageMatch ? pageMatch[0] : '';
        }
        
        const coverElement = doc.querySelector('img#landingImage');
        let cover: string = "";
        if (coverElement) {
          cover = coverElement.getAttribute('src') || "";
          const highResImage = coverElement.getAttribute('data-old-hires');
          if (highResImage) {
            cover = highResImage;
          }
        }
        
        // Extract publisher
        const publisherElement = doc.querySelector('#rpi-attribute-book_details-publisher .rpi-attribute-value span');
        const publisher: string = publisherElement?.textContent?.trim() || '';
        
        // Extract publication date
        const datePublishedElement = doc.querySelector('#rpi-attribute-book_details-publication_date .rpi-attribute-value span');
        const datepublished: string = datePublishedElement?.textContent?.trim() || '';
        
        // Extract language
        const languageElement = doc.querySelector('#rpi-attribute-language .rpi-attribute-value span');
        const language: string = languageElement?.textContent?.trim() || '';

        // Extract canonical URL
        const canonicalLink = doc.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
        const canonicalUrl = canonicalLink?.getAttribute('href')?.trim() || url;
        
        return {
          title: title || '',
          author: author,
          pages: pages,
          cover: cover,
          publisher: publisher,
          translator: translator,
          datepublished: datepublished,
          language: language,
          url: canonicalUrl
        };
      } else if (source === 'behkhaan') {
        const title: string = doc.querySelector('h1#title')?.textContent?.trim() || '';
      
        const authorElement = doc.querySelector('div.w-full.my-2 span.text-sm.md\\:text-base.text-gray-500');
        const author: string = authorElement?.textContent?.trim() || '';
        
        const pagesLabel = Array.from(doc.querySelectorAll('span.text-xs.md\\:text-sm.text-gray-500'))
          .find(el => el.textContent?.includes("تعداد صفحات"));
        let pages: string = '';
        if (pagesLabel) {
          const pagesElement = pagesLabel.parentElement?.nextElementSibling;
          if (pagesElement) {
            const persianNumbers: string[] = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
            let pagesText: string = pagesElement.textContent?.trim() || '';
            persianNumbers.forEach((num, index) => {
              pagesText = pagesText.replace(new RegExp(num, 'g'), index.toString());
            });
            const pageMatch = pagesText.match(/\d+/);
            pages = pageMatch ? pageMatch[0] : '';
          }
        }
        
        let cover: string = doc.querySelector('img.w-full.h-full.object-cover.rounded-lg.cursor-pointer')?.getAttribute("src") || "";
        if (cover && !cover.startsWith("http")) {
          cover = `https://behkhaan.ir${cover}`;
        }

        // Behkhaan: fall back to requested URL (or canonical if present)
        const canonicalLink = doc.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
        const canonicalUrl = canonicalLink?.getAttribute('href')?.trim() || url;
      
        return {
          title: title || '',
          author: author,
          pages: pages,
          cover: cover,
          publisher: '',
          translator: '',
          datepublished: '',
          language: '',
          url: canonicalUrl
        };
      }

      return null;
    } catch (error) {
      new Notice(`Error fetching ${source}: ${(error as Error).message}`, 5000);
      return null;
    }
  }

  // Unique filename function (adapted)
  getUniqueFilename(baseName: string, folder: string): string {
    // Normalize folder path and remove trailing slash
    const normalizedFolder = folder ? normalizePath(folder.replace(/\/$/, '')) : '';
    let counter: number = 1;
    let newName: string = baseName;
    
    // Filter files that are exactly in the target folder (not in subfolders)
    const files = this.app.vault.getMarkdownFiles().filter(f => {
      if (normalizedFolder === '') {
        // For root folder, check if file's parent is the root folder
        return f.parent === this.app.vault.getRoot();
      } else {
        // For specific folder, check if parent path matches exactly
        return f.parent?.path === normalizedFolder;
      }
    });

    while (files.some(file => file.basename === newName)) {
      newName = `${baseName} ${counter}`;
      counter++;
    }
    return newName;
  }
}

// Helper function for type predicate
function isTFolder(f: TAbstractFile): f is TFolder {
  return f instanceof TFolder;
}

// Modal for URL input
class UrlInputModal extends Modal {
  promise: Promise<string>;
  resolve: ((value: string) => void) | null;
  input: HTMLInputElement;

  constructor(app: App) {
    super(app);
    this.resolve = null;
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Enter book URL' });

    this.input = contentEl.createEl('input', { type: 'text', cls: 'add-book-url-input' });
    this.input.focus();

    const buttonContainer = contentEl.createEl('div', { cls: 'add-book-button-container' });
    const button = buttonContainer.createEl('button', { text: 'Submit', cls: 'add-book-submit-button' });
    button.addEventListener('click', () => {
      if (this.resolve) {
        this.resolve(this.input.value);
        this.resolve = null;
      }
      this.close();
    });

    // Handle Enter key
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (this.resolve) {
          this.resolve(this.input.value);
          this.resolve = null;
        }
        this.close();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
    // Resolve with empty string if modal is closed without submitting
    if (this.resolve) {
      this.resolve('');
      this.resolve = null;
    }
  }
}

// File Suggest class
class FileSuggest extends AbstractInputSuggest<TFile> {
  textComponent: TextComponent;

  constructor(app: App, textComponent: TextComponent) {
    super(app, textComponent.inputEl);
    this.textComponent = textComponent;
  }

  protected getSuggestions(query: string): TFile[] {
    const files = this.app.vault.getMarkdownFiles();
    const lowerQuery = query.toLowerCase();
    return files.filter(file => file.path.toLowerCase().includes(lowerQuery));
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  selectSuggestion(file: TFile): void {
    this.textComponent.setValue(file.path);
    this.textComponent.inputEl.dispatchEvent(new Event('input'));
    this.close();
  }
}

// Folder Suggest class
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  textComponent: TextComponent;

  constructor(app: App, textComponent: TextComponent) {
    super(app, textComponent.inputEl);
    this.textComponent = textComponent;
  }

  protected getSuggestions(query: string): TFolder[] {
    const abstractFiles = this.app.vault.getAllLoadedFiles();
    const folders = abstractFiles.filter(isTFolder);
    const lowerQuery = query.toLowerCase();
    return folders.filter(folder => {
      const path = folder.path === '' ? '/' : folder.path;
      return path.toLowerCase().includes(lowerQuery);
    });
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    const path = folder.path === '' ? '/' : folder.path;
    el.setText(path);
  }

  selectSuggestion(folder: TFolder): void {
    const path = folder.path === '' ? '/' : folder.path;
    this.textComponent.setValue(path);
    this.textComponent.inputEl.dispatchEvent(new Event('input'));
    this.close();
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
      .addText(text => {
        text
          .setPlaceholder('Templates/book-template.md')
          .setValue(this.plugin.settings.templatePath)
          .onChange(async (value) => {
            value = value.trim();
            this.plugin.settings.templatePath = normalizePath(value);
            await this.plugin.saveSettings();
          });
        new FileSuggest(this.app, text);
      });

    // Setting for save folder
    new Setting(containerEl)
      .setName('Save folder path')
      .setDesc('Folder to save new notes. If empty, saves to root.')
      .addText(text => {
        text
          .setPlaceholder('Books/')
          .setValue(this.plugin.settings.saveFolder)
          .onChange(async (value) => {
            let normalized = normalizePath(value);
            this.plugin.settings.saveFolder = normalized;
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, text);
      });

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