# fis-postpackager-reqmin

a postpackager plugin for fis to auto replace pack resource and auto combine resources

## 功能

 - 自动将页面中声明的资源引用替换为pack中设置的资源
 - 自动将未打包的零散资源按照引用顺序打包

## 用法

    $ npm install -g fis-postpackager-reqmin
    $ vi path/to/project/fis-conf.js

```javascript
//file : path/to/project/fis-conf.js
fis.config.set('modules.postpackager', 'reqmin');
//关闭autoCombine可以设置是否将零散资源进行打包
//fis.config.set('settings.postpackager.reqmin.autoCombine', false);
```

## DEMO

https://github.com/hefangshi/fis-quickstart-demo

```
$ fis release -pmDf fis-conf-reqmin.js
```