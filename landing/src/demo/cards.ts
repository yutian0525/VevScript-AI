/** 仿真网页的信息流数据。ad 两条是「去掉推广卡片」场景要摘掉的目标。 */
export interface FeedCard {
  id: string;
  kind: 'post' | 'ad';
  title: string;
  author: string;
  time: string;
  /** 折算后的预计阅读时长，第三个场景注入徽标时用 */
  read: string;
  /** 缩略图色调档位，0-3，取 signal 同族的四级明度 */
  tone: 0 | 1 | 2 | 3;
}

export const FEED: FeedCard[] = [
  { id: 'p1', kind: 'post', title: 'View Transitions 的正确用法', author: '柯林', time: '2 小时前', read: '6 分钟', tone: 0 },
  { id: 'a1', kind: 'ad', title: '云主机限时 2 折 · 新用户首年 9.9 元起', author: '推广', time: '赞助', read: '1 分钟', tone: 3 },
  { id: 'p2', kind: 'post', title: '迁到 Manifest V3 的十七个坑', author: '苏晚', time: '5 小时前', read: '11 分钟', tone: 1 },
  { id: 'p3', kind: 'post', title: 'CSS 容器查询替掉了我一半的媒体查询', author: '周叙', time: '昨天', read: '4 分钟', tone: 2 },
  { id: 'a2', kind: 'ad', title: '前端进阶训练营 · 三个月对标大厂 P6', author: '推广', time: '赞助', read: '2 分钟', tone: 3 },
  { id: 'p4', kind: 'post', title: '为什么我们放弃了 Service Worker 缓存', author: '郑迟', time: '两天前', read: '8 分钟', tone: 0 },
];
