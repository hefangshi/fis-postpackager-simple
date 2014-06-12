/*
 * fis
 * http://fis.baidu.com/
 */

'use strict';

var combineCount = 0;
var combineCache = {};
var stable = require("stable");
var defaultSetting = {
    autoCombine : true,
    fullPackHit : {
        js : false, //js will use pack when one resource hit the pack
        css : true //css will use pack only when full pack hit
    }
};
/**
 * 获取html页面中的<script ... src="path"></script> 资源
 * 获取html页面中的<link ... rel="stylesheet" href="path" /> 资源
 * 由于已经在标准流程之后，无需处理inline
 * 不需要改动页面中内嵌的样式
 * 需要将页面中内嵌的脚本移动到所有脚本的最下方
 * 需要去除注释内的引用
 * @param content
 * @param pathMap
 */
function analyzeHtml(content, pathMap) {
    var reg = /(<script(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?:<\/script\s*>\s?\r?\n|$)|<(link)\s+[\s\S]*?["'\s\w\/\-](?:>\s?\r?\n|$)|<!--([\s\S]*?)(?:-->\s?\r?\n|$)/ig;
    var single, result;
    var resources = {
        scripts: [],
        inlineScripts: [],
        styles: []
    };
    var replaced = content.replace(reg, function (m, $1, $2, $3, $4) {
        //$1为script标签, $2为内嵌脚本内容, $3为link标签, $4为注释内容
        if ($1) {
            //如果标签设置了data-fixed则不会收集此资源
            if (/(\sdata-fixed\s*=\s*)('true'|"true")/ig.test($1)) {
                return m;
            }
            if ($2) {
                resources.inlineScripts.push({content: m });
            } else {
                result = m.match(/(?:\ssrc\s*=\s*)(?:'([^']+)'|"([^"]+)"|[^\s\/>]+)/i);
                if (result && (result[1] || result[2])) {
                    var jsUrl = result[1] || result[2];
                    //不在资源表中的资源不处理
                    if (!pathMap[jsUrl]){
                        return m;
                    }
                    single = false;
                    if (/(\sdata-single\s*=\s*)('true'|"true")/ig.test($1)) {
                        single = true;
                    }
                    resources.scripts.push({
                        content: m,
                        id: pathMap[jsUrl],
                        single: single
                    });
                }
            }
        } else if ($3) {
            var isCssLink = false;
            result = m.match(/\srel\s*=\s*('[^']+'|"[^"]+"|[^\s\/>]+)/i);
            if (result && result[1]) {
                var rel = result[1].replace(/^['"]|['"]$/g, '').toLowerCase();
                isCssLink = rel === 'stylesheet';
            }
            //对rel不是stylesheet的link不处理
            if (!isCssLink){
                return m;
            }
            //如果标签设置了data-fixed则不会收集此资源
            if (/(\sdata-fixed\s*=\s*)('true'|"true")/ig.test(m)) {
                return m;
            }
            result = m.match(/(?:\shref\s*=\s*)(?:'([^']+)'|"([^"]+)"|[^\s\/>]+)/i);
            if (result && (result[1] || result[2])) {
                var cssUrl = result[1] || result[2];
                if (!pathMap[cssUrl]){
                    return m;
                }
                single = false;
                if (/(\sdata-single\s*=\s*)('true'|"true")/ig.test(m)) {
                    single = true;
                }
                resources.styles.push({
                    content: m,
                    id: pathMap[cssUrl],
                    single: single
                });
            }
        } else if ($4) {
            //不处理注释
            return m;
        }
        return '';
    });
    return {
        resources: resources,
        content: replaced
    };
}

function getResourcePathMap(ret) {
    var map = {};
    fis.util.map(ret.map.res, function (subpath, file) {
        map[file.uri] = subpath;
    });
    return map;
}

/**
 * 将页面依赖的资源与打包资源对比合并
 * @param resources
 * @param ret
 * @param fullPackHit 是否要求资源整体命中打包对象
 * @returns {Array}
 */
function getPkgResource(resources, ret, fullPackHit) {
    var pkgList = {};
    var list = [];
    var handled = {};
    var idList = resources.map(function(resource){
       return  resource.id;
    });

    function fullPackPass(resource){
        if (!fullPackHit){
            return true;
        }
        var pkg = ret.map.pkg[ret.map.res[resource.id].pkg];
        var unHit = pkg.has.filter(function (id) {
            return idList.indexOf(id) == -1;
        });
        return unHit.length === 0;
    }

    resources.forEach(function (resource) {
        var id = resource.id;
        if (handled[id]){
            return false;
        }
        var res = ret.map.res[id];
        handled[id] = true;
        if (res.pkg && fullPackPass(resource)) {
            ret.map.pkg[res.pkg].has.forEach(function(inPkg){
                handled[inPkg] = true;
            });
            pkgList[res.pkg] = true;
            list.push({
                type: 'pkg',
                id: res.pkg
            });
        } else {
            list.push({
                type: 'res',
                id: id,
                single: resource.single
            });
        }
    });
    return list;
}

/**
 * 自动打包零散资源
 * @param resList
 * @param ret
 * @param settings
 * @param conf
 * @param opt
 * @returns {Array}
 */
function autoCombine(resList, ret, conf, settings, opt) {
    var list = [];
    var toCombine = [];
    var fileExt;

    function getCombineHash(list){
        var idList = list.map(function(res){
            return res.id;
        });
        var sorted = stable(idList).join(',');
        return sorted;
    }

    function flushCombine() {
        if (toCombine.length == 1) {
            //单独的文件不进行处理
            list.push(toCombine[0]);
            toCombine = [];
            return;
        }
        if (toCombine.length !== 0) {
            var hash = getCombineHash(toCombine);
            var content = '';
            var index = 0;
            var has = [];
            var id;
            if (combineCache[hash]){
                fis.log.debug('auto combine hit cache [' + hash + ']');
                id = combineCache[hash];
            }
            else{
                toCombine.forEach(function (res) {
                    var file = ret.ids[res.id];
                    var c = file.getContent();
                    has.push(file.getId());
                    if (!fileExt) {
                        fileExt = file.isJsLike ? 'js' : 'css';
                    }
                    if (c !== '') {
                        if (index++ > 0) {
                            content += '\n';
                            if (file.isJsLike) {
                                content += ';';
                            } else if (file.isCssLike) {
                                c = c.replace(/@charset\s+(?:'[^']*'|"[^"]*"|\S*);?/gi, '');
                            }
                        }
                        content += c;
                    }
                });
                var subpath = 'pkg/auto_combine_${index}'.replace('${index}', combineCount) + '.' + fileExt;
                var file = fis.file(fis.project.getProjectPath(), subpath);
                ret.pkg[file.subpath] = file;
                file.setContent(content);
                id = "auto_" + fileExt + "_" + combineCount;
                ret.map.pkg[id] = {
                    uri: file.getUrl(opt.hash, opt.domain),
                    type: fileExt,
                    has: has
                };
                combineCache[hash] = id;
                combineCount++;
            }
            list.push({
                type: 'pkg',
                id: id
            });
            toCombine = [];
        }
    }

    resList.forEach(function (res) {
        if (res.type === 'pkg') {
            flushCombine();
            list.push(res);
        } else {
            if (res.single) {
                flushCombine();
                list.push(res);
            } else {
                toCombine.push(res);
            }
        }
    });
    flushCombine();
    return list;
}

function injectJs(jsList, content, ret) {
    function getCharset() {
        var charset = fis.config.get('project.charset');
        switch (charset) {
            case 'utf8':
                return 'utf-8';
            default:
                return charset;
        }
    }

    var script = '';
    jsList.forEach(function (js) {
        var uri;
        if (js.type === 'pkg') {
            uri = ret.map.pkg[js.id].uri;
        } else {
            uri = ret.map.res[js.id].uri;
        }
        script += '<script type="text/javascript" charset="' + getCharset() + '" src="' + uri + '"></script>\r\n';
    });
    return content.replace(/<\/body>/, script + '\n$&');
}

function injectCss(cssList, content, ret) {
    var styles = '';
    cssList.forEach(function (css) {
        var uri;
        if (css.type === 'pkg') {
            uri = ret.map.pkg[css.id].uri;
        } else {
            uri = ret.map.res[css.id].uri;
        }
        styles += '<link type="text/css" rel="stylesheet" href="' + uri + '"/>\r\n';
    });
    return content.replace(/<\/head>/, styles + '\n$&');
}

function injectInlineJs(inlineScripts, content, ret) {
    var inline = '';
    inlineScripts.forEach(function (script) {
        inline += script.content;
    });
    return content.replace(/<\/body>/, inline + '\n$&');
}

module.exports = function (ret, conf, settings, opt) { //打包后处理
    if (!opt.pack){
        return;
    }
    combineCache = {};
    combineCount = 0;
    settings = fis.util.merge(fis.util.clone(defaultSetting), settings);
    var pathMap = getResourcePathMap(ret);
    fis.util.map(ret.src, function (subpath, file) {
        if (file.isHtmlLike && file.noMapJs !== false) { //类html文件
            var content = file.getContent();
            var result = analyzeHtml(content, pathMap);
            var jsList = getPkgResource(result.resources.scripts, ret, settings.fullPackHit.js);
            var cssList = getPkgResource(result.resources.styles, ret, settings.fullPackHit.css);
            if (settings.autoCombine !== false) {
                jsList = autoCombine(jsList, ret,  conf, settings, opt);
                cssList = autoCombine(cssList, ret, conf, settings,  opt);
            }
            content = injectJs(jsList, result.content, ret);
            content = injectCss(cssList, content, ret);
            content = injectInlineJs(result.resources.inlineScripts, content, ret);
            file.setContent(content);
        }
    });
};
