// tests/shared/match-pattern.test.ts
import { describe, it, expect } from 'vitest';
import { isValidMatchPattern, matchPatternToRegExp, matchUrl } from '../../shared/match-pattern';

describe('isValidMatchPattern', () => {
  it('接受合法 pattern 与 <all_urls>', () => {
    expect(isValidMatchPattern('<all_urls>')).toBe(true);
    expect(isValidMatchPattern('https://example.com/*')).toBe(true);
    expect(isValidMatchPattern('*://example.com/*')).toBe(true);
    expect(isValidMatchPattern('http://*.example.com/foo/*bar')).toBe(true);
    expect(isValidMatchPattern('file:///foo/*')).toBe(true);
  });
  it('拒绝非法 pattern', () => {
    expect(isValidMatchPattern('https://example.com')).toBe(false);      // 缺路径
    expect(isValidMatchPattern('http://*foo.com/*')).toBe(false);        // 宿主 * 后跟字符
    expect(isValidMatchPattern('https://example.com:8080/*')).toBe(false); // 不允许端口
    expect(isValidMatchPattern('chrome://*')).toBe(false);               // 非法 scheme
    expect(isValidMatchPattern('')).toBe(false);
  });
});

describe('matchUrl', () => {
  it('路径通配匹配', () => {
    expect(matchUrl(['https://example.com/*'], 'https://example.com/a/b?c=1')).toBe(true);
    expect(matchUrl(['https://example.com/*'], 'https://other.com/')).toBe(false);
    expect(matchUrl(['https://example.com/a/*'], 'https://example.com/b/')).toBe(false);
  });
  it('scheme * 匹配 http/https', () => {
    expect(matchUrl(['*://example.com/*'], 'http://example.com/')).toBe(true);
    expect(matchUrl(['*://example.com/*'], 'https://example.com/')).toBe(true);
    expect(matchUrl(['*://example.com/*'], 'ftp://example.com/')).toBe(false);
  });
  it('*.example.com 含裸域（可选子域）', () => {
    expect(matchUrl(['*://*.example.com/*'], 'https://sub.example.com/x')).toBe(true);
    expect(matchUrl(['*://*.example.com/*'], 'https://example.com/x')).toBe(true);
    expect(matchUrl(['*://*.example.com/*'], 'https://notexample.com/')).toBe(false);
  });
  it('<all_urls> 匹配普通页但不匹配受限页', () => {
    expect(matchUrl(['<all_urls>'], 'https://a.com/')).toBe(true);
    expect(matchUrl(['<all_urls>'], 'chrome://extensions/')).toBe(false);
    expect(matchUrl(['<all_urls>'], 'about:blank')).toBe(false);
  });
  it('非法 pattern 不抛出、不匹配', () => {
    expect(matchUrl(['https://bad'], 'https://bad')).toBe(false);
  });
  it('空 matches 恒不匹配', () => {
    expect(matchUrl([], 'https://example.com/')).toBe(false);
  });
  it('裸根路径 / 非通配开头路径需与带斜杠的实际 URL 匹配（曾因 host/path 间遗漏字面量 / 分隔符而全部失配）', () => {
    expect(matchUrl(['https://www.baidu.com/'], 'https://www.baidu.com/')).toBe(true);
    expect(matchUrl(['http://www.baidu.com/'], 'http://www.baidu.com/')).toBe(true);
    expect(matchUrl(['https://www.baidu.com/index.php*'], 'https://www.baidu.com/index.php?tn=1')).toBe(true);
    expect(matchUrl(['https://www.baidu.com/index.php*'], 'https://www.baidu.com/other.php')).toBe(false);
  });
});
