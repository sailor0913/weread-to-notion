/**
 * 带配置过滤的批量同步所有书籍模块
 */

import { enhanceBookMetadata } from "../formatter";
import { syncBookContent } from "./book-sync";
import { saveSyncState } from "../../utils/file";
import {
  getNotebookBooks,
  getBookshelfBooks,
  getBookInfo,
} from "../../api/weread/services";
import {
  checkBookExistsInNotion,
  writeBookToNotion,
} from "../../api/notion/services";
import {
  loadLibraryConfig,
  checkSyncConfigExists,
  createDefaultSyncConfig,
} from "../../api/notion/config-service";
import { filterBooksByConfig, showFilterStats } from "../book-filter";
import { LibraryConfig } from "../../config/types";

/**
 * 同步所有书籍到Notion（带配置过滤）
 */
export async function syncAllBooksWithConfig(
  apiKey: string,
  databaseId: string,
  cookie: string,
  useIncremental: boolean = true,
  configDatabaseId?: string
): Promise<void> {
  console.log(
    `\n=== 开始${useIncremental ? "增量" : "全量"}同步所有书籍（带配置过滤）===`
  );

  try {
    // 1. 加载同步配置
    let config: LibraryConfig = {
      enabledReadingStatus: ["已读", "在读", "未读"], // 默认同步所有状态
      enabledAuthors: [], // 默认不限制作者
    };

    if (configDatabaseId) {
      // 检查配置是否存在，如果不存在则创建默认配置
      const configExists = await checkSyncConfigExists(
        apiKey,
        configDatabaseId
      );
      if (!configExists) {
        console.log("配置数据库中未找到同步配置，正在创建默认配置...");
        await createDefaultSyncConfig(apiKey, configDatabaseId);
      }

      // 加载配置
      config = await loadLibraryConfig(apiKey, configDatabaseId);
    } else {
      console.log("未提供配置数据库ID，使用默认配置（同步所有状态）");
    }

    // 新增：根据配置 syncMode 决定 useIncremental
    const useIncrementalFromConfig = config.syncMode !== "全量";
    // 新增：根据配置决定是否按章节组织
    const organizeByChapterFromConfig = config.organizeByChapter === "是";

    console.log(`同步模式: ${config.syncMode || "增量"}`);
    console.log(`按章节划线: ${config.organizeByChapter || "否"}`);

    // 2. 获取书架中的书籍
    const shelfBooks = await getBookshelfBooks(cookie);

    // 3. 获取笔记本中的书籍（有划线的书籍）
    const notebookBooks = await getNotebookBooks(cookie);

    // 4. 合并书籍元数据
    const allBooks = await enhanceBookMetadata(
      cookie,
      shelfBooks,
      notebookBooks
    );

    // 5. 根据配置过滤书籍
    const booksToSync = filterBooksByConfig(allBooks, config);

    // 6. 显示过滤统计信息
    showFilterStats(allBooks, booksToSync, config);

    console.log(`\n准备同步 ${booksToSync.length} 本书到Notion...`);

    // 同步结果统计
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    // 遍历所有书籍并同步
    for (let i = 0; i < booksToSync.length; i++) {
      const book = booksToSync[i];
      console.log(
        `\n[${i + 1}/${booksToSync.length}] 同步《${book.title}》...`
      );
      // 检查书籍是否已存在于Notion
      const { exists, pageId: existingPageId } = await checkBookExistsInNotion(
        apiKey,
        databaseId,
        book.title,
        book.author
      );

      let finalPageId: string;

      if (exists && existingPageId) {
        console.log(`《${book.title}》已存在于Notion，将更新现有记录`);
        finalPageId = existingPageId;
      } else {
        // 获取书籍详细信息（包括ISBN和出版社）
        console.log(`获取《${book.title}》的详细信息...`);
        const detailedBookInfo = await getBookInfo(cookie, book.bookId);

        // 合并详细信息到书籍数据中
        const enhancedBook = {
          ...book,
          // 优先使用详细API返回的信息
          isbn: detailedBookInfo?.isbn || book.isbn || "",
          publisher: detailedBookInfo?.publisher || book.publisher || "",
          // 其他可能的详细信息也可以在这里添加
          intro: detailedBookInfo?.intro || book.intro || "",
          publishTime: detailedBookInfo?.publishTime || book.publishTime || "",
        };

        console.log(
          `获取到ISBN: ${enhancedBook.isbn}, 出版社: ${enhancedBook.publisher}`
        );

        // 写入书籍元数据到Notion
        const writeResult = await writeBookToNotion(
          apiKey,
          databaseId,
          enhancedBook
        );

        if (!writeResult.success || !writeResult.pageId) {
          failCount++;
          console.log(`《${book.title}》同步失败`);
          continue; // 跳过此书继续处理下一本
        }
        finalPageId = writeResult.pageId;
      }

      // 同步书籍内容
      const syncContentResult = await syncBookContent(
        apiKey,
        databaseId,
        cookie,
        book.bookId,
        finalPageId,
        book,
        useIncrementalFromConfig,
        organizeByChapterFromConfig
      );

      // 检查是否有真正的更新
      const hasUpdates =
        syncContentResult.hasUpdate || !useIncrementalFromConfig;

      if (!hasUpdates) {
        console.log(`《${book.title}》没有检测到新内容，跳过同步`);
        skippedCount++;
        continue; // 跳过此书继续处理下一本
      }

      // 保存同步状态（无论增量还是全量同步都需要保存，以便下次增量同步使用）
      const syncState = {
        bookId: book.bookId,
        lastSyncTime: Date.now(),
        highlightsSynckey: syncContentResult.highlightsSynckey,
        thoughtsSynckey: syncContentResult.thoughtsSynckey,
      };
      saveSyncState(syncState);
      console.log(
        `已保存同步状态，highlightsSynckey: ${syncContentResult.highlightsSynckey}, thoughtsSynckey: ${syncContentResult.thoughtsSynckey}`
      );

      if (syncContentResult.success) {
        console.log(`《${book.title}》同步成功`);
        successCount++;
      } else {
        console.log(`《${book.title}》基本信息同步成功，但内容同步失败`);
        failCount++;
      }

      // 添加延迟，避免请求过快
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log("\n=== 同步完成 ===");
    console.log(
      `成功: ${successCount} 本，失败: ${failCount} 本，跳过(无更新): ${skippedCount} 本`
    );
  } catch (error: any) {
    console.error("同步过程中发生错误:", error.message);
  }
}
