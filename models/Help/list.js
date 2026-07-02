export const List = [
  {
    group: '[]内为必填项,{}内为可选项'
  },
  {
    group: '拓展命令',
    list: [
      {
        icon: 161,
        title: '#清语表情列表',
        desc: '获取表情列表'
      },
      {
        icon: 90,
        title: '#清语表情搜索xx',
        desc: '搜指定的表情'
      },
      {
        icon: 75,
        title: '#清语表情详情xx',
        desc: '获取指定表情详情'
      },
      {
        icon: 72,
        title: '#清语表情统计',
        desc: '获取表情统计'
      },
      {
        icon: 71,
        title: 'xx',
        desc: '如喜报xx (参数使用#参数名 参数值,, 多段文本使用/, 指定用户头像使用@+qq号)'
      },
      {
        icon: 60,
        title: '#图片旋转90/#图片缩放512x512',
        desc: '引用或发送图片后进行旋转、缩放、坐标裁剪'
      },
      {
        icon: 61,
        title: '#裁剪3x4 边距10',
        desc: '按行列网格切图，支持边距上/下/左/右'
      },
      {
        icon: 62,
        title: '#图片灰度/#图片反色/#图片水平翻转',
        desc: '引用或发送图片后进行基础图片处理'
      },
      {
        icon: 63,
        title: '#图片横向拼接/#图片纵向拼接',
        desc: '引用或发送多张图片后进行拼接'
      },
      {
        icon: 64,
        title: '#GIF/gif拆帧/#gif分解/#gif倒放',
        desc: '引用或发送 GIF 后进行帧级处理'
      },
      {
        icon: 65,
        title: '#合成1gif8x8 0.05s/#合成2gif8x8',
        desc: '精灵图按行列切帧后合成为 GIF'
      },
      {
        icon: 66,
        title: '#多图合成gif 10fps/#gif合成80',
        desc: '引用或发送多张图片后合成为 GIF'
      }
    ]
  },
  {
    group: '管理命令，仅主人可用',
    auth: 'master',
    list: [
      {
        icon: 95,
        title: '#清语表情{插件}{强制}更新',
        desc: '更新插件本体'
      },
      {
        icon: 81,
        title: '#清语表情({强制}更新资源',
        desc: '更新表情资源'
      },
      {
        icon: 85,
        title: '#清语表情设置',
        desc: '管理命令'
      }
    ]
  }
]
