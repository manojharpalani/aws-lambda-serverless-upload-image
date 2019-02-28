'use strict'

const AWS = require('aws-sdk');
const s3 = new AWS.S3()
const moment = require('moment');
const fileType = require('file-type');
const shortid = require('shortid');
const documentClient = new AWS.DynamoDB.DocumentClient(); 
const Sharp = require('sharp');
const sizeOf = require('image-size');
const maxResolution = parseInt(process.env.THUMBNAIL_MAX_RESOLUTION);
const thumbnailFormat = process.env.THUMBNAIL_FORMAT;

exports.handler = function(event, context, callback) {
    let id = event.id;
    let isDisplayImage = event.isDisplayImage == 'true';
    let base64String = event.body.base64String;
    let originalFileFullPath = null;
    let thumbnailFileFullPath = null;
    let randomName = shortid.generate();

    if (id == null) {
        return context.fail('Id not specified in input.');
    }

    if (base64String == null) {
        return context.fail('base64String not specified in input.');
    }

    let buffer = new Buffer(base64String, 'base64');
    let fileMime = fileType(buffer);

    if (fileMime == null) {
        return context.fail('File type not specified in input.');
    }


    // Prepare file params
    // Upload Thumbnail S3
    // Upload Original Image to S3
    // Update in Dynamo DB
    // Return success response
    prepareOriginalFile(id, buffer, fileMime, randomName)
        .then(response => {
            originalFileFullPath = response.fullPath;
            return s3.putObject(response.params).promise();
            })
        .then(() => {
            if(isDisplayImage) {
                return prepareThumbnailFile(id, buffer, fileMime, randomName);
            } else {
                return Promise.resolve();
            }   
            })
        .then((response) => {
            if(isDisplayImage) {
                thumbnailFileFullPath = response.fullPath;
                return s3.putObject(response.params).promise();
            } else {
                return Promise.resolve();
            }   
            })
        .then(() => initImageInPost(id, originalFileFullPath, thumbnailFileFullPath, isDisplayImage))
        .then(() => callback(null, {
            "image": originalFileFullPath,
            "thumbnail": thumbnailFileFullPath
        }))
        .catch(err => callback(err));
}

let prepareOriginalFile = function (id, buffer, fileMime, randomName) { 
    let fileExt = fileMime.ext;
    let fileName = id + '/' + randomName + '.' + fileExt;
    let fileFullPath = process.env.S3_HOST_URL + fileName;

    // Prepare response
    let response = {
        fullPath: fileFullPath,
        params: {
            Bucket: process.env.S3_BUCKET,
            Key: fileName,
            Body: buffer
        }
    };
    console.log('Preparing originalFile: ' + response.fullPath);
    return new Promise(function(resolve, reject) {
        resolve(response);
    });
}

let prepareThumbnailFile = function (id, buffer, fileMime, randomName) { 

    let thumbnailFileName = id + '/' + randomName + '-thumbnail.' + thumbnailFormat;
    let thumbnailFullPath = process.env.S3_HOST_URL + thumbnailFileName;
    
    let dimensions = sizeOf(buffer);
    console.log('Dimensions : ' + JSON.stringify(dimensions));
    let aspectRatio = dimensions.width / dimensions.height;
    let resizeHeight, resizeWidth;
    let resize = false;

    // portrait
    if (dimensions.width < dimensions.height && dimensions.height > maxResolution) {
        resize = true;
        resizeHeight = maxResolution;
        resizeWidth = Math.round(aspectRatio * resizeHeight);
    } else if (dimensions.width > dimensions.height && dimensions.width > maxResolution) { // landscape
        resize = true;
        resizeWidth = maxResolution;
        resizeHeight = Math.round(maxResolution / aspectRatio);
    } else {
        resize = false;
        console.log('No need to resize, image is small enough');
    }

    if(resize) {
        console.log('Resize Dimensions: width:' + resizeWidth + ' height: ' + resizeHeight);
        return new Promise(function(resolve, reject) {
            Sharp(buffer)
              .resize(resizeWidth, resizeHeight)
              .toFormat(thumbnailFormat)
              .toBuffer().then(buf => {
                    let response = {
                    fullPath: thumbnailFullPath,
                    params: {
                            Bucket: process.env.S3_BUCKET,
                            Key: thumbnailFileName,
                            Body: buf
                        }
                    };
                    console.log('Preparing thumbnailFile: ' + response.fullPath);
                    resolve(response);
              }).catch(err => reject(err));
        }); 
    } else {
        let response = {
        fullPath: thumbnailFullPath,
        params: {
                Bucket: process.env.S3_BUCKET,
                Key: thumbnailFileName,
                Body: buffer
            }
        };
        console.log('Preparing thumbnailFile: ' + response.fullPath);
        return new Promise(function(resolve, reject) {
            resolve(response);
        });
    } 
    
}

let addImageToPost = function(postId, newImage, newThumbnailImage, isDisplayImage) {
    var newImages = [];
    newImages.push(newImage);
    var updateExpression = "set #imgs = list_append(#imgs, :nimgs)";
    
    var expressionAttributeNames = {
            "#imgs" : "images"
    };
    
    var expressionAttributeValues = {
            ":nimgs": newImages
    };
    
    var updatedDateTime = (new Date).getTime();
    updateExpression += ', updatedDateTime = :updatedDateTime';
    expressionAttributeValues[':updatedDateTime'] = updatedDateTime;
    
    // Update image attribute as well if image being uploaded is 
    // to be set as display image as well.
    if (isDisplayImage) {
        updateExpression += ', #img = :nimg';
        expressionAttributeNames['#img'] = 'image';
        expressionAttributeValues[':nimg'] = newThumbnailImage;
    }
    
    var params = {
        TableName : process.env.TABLE_NAME,
        Key: {
            "id": postId
        },
        ConditionExpression: "attribute_exists(#imgs)",
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues:expressionAttributeValues,
        ReturnValues:"UPDATED_NEW"
    };
    console.log('Adding image to post in DynamoDB : ' + JSON.stringify(params));
    return documentClient.update(params).promise();
}

let initImageInPost = function(postId, newImage, newThumbnailImage, isDisplayImage) {
    var newImages = [];
    newImages.push(newImage);
    var updateExpression = "set #imgs = :nimgs";
    
    var expressionAttributeNames = {
            "#imgs" : "images"
    };
    
    var expressionAttributeValues = {
            ":nimgs": newImages
    };
    
    var updatedDateTime = (new Date).getTime();
    updateExpression += ', updatedDateTime = :updatedDateTime';
    expressionAttributeValues[':updatedDateTime'] = updatedDateTime;
    
    // Update image attribute as well if image being uploaded is 
    // to be set as display image as well.
    if (isDisplayImage) {
        updateExpression += ', #img = :nimg';
        expressionAttributeNames['#img'] = 'image';
        expressionAttributeValues[':nimg'] = newThumbnailImage;
    }
    
    var params = {
        TableName : process.env.TABLE_NAME,
        Key: {
            "id": postId
        },
        ConditionExpression: "attribute_not_exists(#imgs)",
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues:"UPDATED_NEW"
    };

    console.log('Initializing first image to post in DynamoDB : ' + JSON.stringify(params));

    documentClient.update(params, function(err, data){
        if(err){
            return addImageToPost(postId, newImage, newThumbnailImage, isDisplayImage);
        }else{
            console.log('Response ' + JSON.stringify(data));
            return Promise.resolve();
        }
    });
}