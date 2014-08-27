# fis-postpackager-simple

用于自动打包页面零散资源和应用打包资源的[FIS](https://github.com/fex-team/fis/)插件

## 功能

 - 自动将页面中声明的资源引用替换为pack中设置的资源
 - 自动将未打包的零散资源按照引用顺序打包，默认关闭

## 用法

    $ npm install -g fis-postpackager-simple
    $ vi path/to/project/fis-conf.js #编辑项目配置文件

```javascript
//file : path/to/project/fis-conf.js
//使用simple插件，自动应用pack的资源引用
fis.config.set('modules.postpackager', 'simple');
//开始autoCombine可以将零散资源进行自动打包
fis.config.set('settings.postpackager.simple.autoCombine', true);
//开启autoReflow使得在关闭autoCombine的情况下，依然会优化脚本与样式资源引用位置
fis.config.set('settings.postpackager.simple.autoReflow', true);
```

## 自动打包处理策略

开启了autoCombine后，为了保证资源引用顺序的正确，插件会自动调整脚本的加载位置

 - ```<script src='path'></script>``` 引用的脚本默认会在打包后移动到body底部
 - ```<script data-position='head'></script>``` 引用或声明的脚本会移动到head底部
 - ```<script|link data-single='true'></script|link>``` 引用或声明的脚本和样式不会进行自动打包
 - ```<link rel='stylesheet' href='path'>``` 引用的样式表默认会在打包后移动到head底部
 - ```<link rel='stylesheet' href='path'>``` 引用的样式表默认会在打包后移动到head底部
 - ```<script>console.log('hello world')</script>``` 编写的内嵌脚本将会移动到body底部
 - ```<script|link data-fixed='true'>``` 声明的标签不会被处理
 - ```<style></style>``` 不会进行任何处理

## 配置项

### autoCombine

设置是否自动将零散资源进行打包，默认为 `false`

### autoReflow

设置是否自动优化脚本与样式资源引用位置，默认为 `false`

### fullPackHit

设置是否资源需要全部命中pack设置才会将整个资源包引用

#### fullPackHit.js

默认为 `false`

#### fullPackHit.css

默认为 `false`

### forceOutput

autoCombine或autoReflow时是否对不包含head和body的页面强制输出合并脚本

### headTag

autoCombine或autoReflow时自定义 `</head>` 标记设置，如 `<!--HEAD_END-->`。

**注意** 替换完成后，headTag最终将不会被删除


### bodyTag

autoCombine或autoReflow时自定义 `</body>` 标记设置，如 `<!--BODY_END-->`。

**注意** 替换完成后，bodyTag最终将不会被删除

### output

合成文件输出路径，默认值 "pkg/auto_combine_${hash}" ${hash}为合成内容hash值 ${index}为合成文件序列


## 适应范围

用于简单的Web前端项目自动打包减少页面请求连接数，同时可以通过[pack](https://github.com/fex-team/fis/wiki/%E9%85%8D%E7%BD%AEAPI#pack)设置来对公共资源进行独立打包。

## DEMO

https://github.com/hefangshi/fis-quickstart-demo
