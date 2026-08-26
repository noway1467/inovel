import { describe, expect, it } from "vitest";
import { isLikelyTitle, isVolumeTitle } from "../../app/server/imports/chapter-rules";

describe("chapter-rules", () => {
  it("识别标准中文章节标题", () => {
    expect(isLikelyTitle("第一章 夜雨")).toBe(true);
    expect(isLikelyTitle("第十二章 乱世浮生")).toBe(true);
    expect(isLikelyTitle("第100章 终章")).toBe(true);
    expect(isLikelyTitle("第一百二十三回 谁主沉浮")).toBe(true);
    expect(isLikelyTitle("第 3 节 风起")).toBe(true);
  });

  it("识别卷首与特殊章节", () => {
    expect(isLikelyTitle("序章")).toBe(true);
    expect(isLikelyTitle("楔子")).toBe(true);
    expect(isLikelyTitle("尾声")).toBe(true);
    expect(isLikelyTitle("番外：校园篇")).toBe(true);
    expect(isVolumeTitle("第一卷 星辰大海")).toBe(true);
  });

  it("识别数字序号标题", () => {
    expect(isLikelyTitle("1、初入江湖")).toBe(true);
    expect(isLikelyTitle("12. 海上月明")).toBe(true);
  });

  it("识别纯数字与前导零章节号", () => {
    expect(isLikelyTitle("001")).toBe(true);
    expect(isLikelyTitle("42")).toBe(true);
    expect(isLikelyTitle("012 风起")).toBe(true);
    expect(isLikelyTitle("第053节")).toBe(true);
    expect(isLikelyTitle("第一百零5章 混搭数字")).toBe(true);
    expect(isLikelyTitle("第1集")).toBe(true);
    expect(isLikelyTitle("第一集")).toBe(true);
  });

  it("识别中文序号、括号序号与正文前缀", () => {
    expect(isLikelyTitle("一、开端")).toBe(true);
    expect(isLikelyTitle("十二、重逢")).toBe(true);
    expect(isLikelyTitle("（3）夜访")).toBe(true);
    expect(isLikelyTitle("(十二) 山雨欲来")).toBe(true);
    expect(isLikelyTitle("正文 第一章 启程")).toBe(true);
    expect(isLikelyTitle("前言")).toBe(true);
    expect(isLikelyTitle("终章")).toBe(true);
    expect(isLikelyTitle("大结局")).toBe(true);
  });

  it("卷章同行按章节处理而不是被卷吞掉", () => {
    expect(isVolumeTitle("第五卷、第九章")).toBe(false);
    expect(isLikelyTitle("第五卷、第九章")).toBe(true);
    expect(isVolumeTitle("第五卷 第九章 风云再起")).toBe(false);
    expect(isLikelyTitle("第五卷 第九章 风云再起")).toBe(true);
    expect(isVolumeTitle("第一卷 星辰大海")).toBe(true);
  });

  it("拒绝时间短句误判", () => {
    expect(isLikelyTitle("3 天后")).toBe(false);
    expect(isLikelyTitle("10 分钟后")).toBe(false);
  });

  it("不把以章节词开头的完整正文句误判为目录", () => {
    expect(isLikelyTitle("第一章正文。")).toBe(false);
    expect(isLikelyTitle("第二章发生了什么？")).toBe(false);
    expect(isLikelyTitle("第三章终于结束了！")).toBe(false);
  });
  it("拒绝正文行和超长行", () => {
    expect(isLikelyTitle("这一夜，长安城的灯火依旧明亮，方澄坐在灯下整理卷宗，窗外的雪落得很轻。")).toBe(false);
    const longTitle = `第一章 ${"很长的章节标题内容，".repeat(6)}`;
    expect(longTitle.length).toBeGreaterThan(60);
    expect(isLikelyTitle(longTitle)).toBe(false);
  });
});
