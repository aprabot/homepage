import json
import boto3
import os

s3 = boto3.client('s3')
BUCKET = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
KEY    = os.environ.get('INSIGHTS_KEY', 'insights/latest.json')

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
}

def handler(event, context):
    method = (event.get('requestContext') or {}).get('http', {}).get('method', 'GET')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}
    try:
        obj  = s3.get_object(Bucket=BUCKET, Key=KEY)
        body = obj['Body'].read().decode('utf-8')
        return {
            'statusCode': 200,
            'headers': {**CORS, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600'},
            'body': body,
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': CORS,
            'body': json.dumps({'error': str(e)}),
        }
