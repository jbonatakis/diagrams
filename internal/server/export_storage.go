package server

import (
	"context"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type exportObject struct {
	Size        int64
	ContentType string
	SHA256      string
}

type exportStorage interface {
	ObjectKey(string) string
	PresignPut(context.Context, string, exportObject, time.Duration) (string, http.Header, error)
	PresignGet(context.Context, string, string, string, time.Duration) (string, error)
	Head(context.Context, string) (exportObject, error)
}

type r2Storage struct {
	bucket string
	client *s3.Client
	signer *s3.PresignClient
}

func newR2Storage(endpoint, bucket, accessKey, secretKey string) (*r2Storage, error) {
	if endpoint == "" || bucket == "" || accessKey == "" || secretKey == "" {
		return nil, fmt.Errorf("R2 storage is not fully configured")
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || strings.ContainsAny(bucket, "/\\") {
		return nil, fmt.Errorf("invalid R2 endpoint or bucket")
	}
	cfg := aws.Config{Region: "auto", Credentials: aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""))}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(strings.TrimSuffix(endpoint, "/"))
		o.UsePathStyle = true
		o.RetryMaxAttempts = 1
	})
	return &r2Storage{bucket: bucket, client: client, signer: s3.NewPresignClient(client)}, nil
}

func (r *r2Storage) ObjectKey(id string) string {
	return id
}

func (r *r2Storage) PresignPut(ctx context.Context, id string, object exportObject, ttl time.Duration) (string, http.Header, error) {
	input := &s3.PutObjectInput{
		Bucket: aws.String(r.bucket), Key: aws.String(id),
		ContentType: aws.String(object.ContentType), ContentLength: aws.Int64(object.Size),
		ChecksumSHA256: aws.String(object.SHA256), IfNoneMatch: aws.String("*"),
	}
	result, err := r.signer.PresignPutObject(ctx, input, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil {
		return "", nil, err
	}
	return result.URL, result.SignedHeader, nil
}

func (r *r2Storage) PresignGet(ctx context.Context, id, filename, contentType string, ttl time.Duration) (string, error) {
	input := &s3.GetObjectInput{
		Bucket: aws.String(r.bucket), Key: aws.String(id),
		ResponseContentType:        aws.String(contentType),
		ResponseContentDisposition: aws.String(exportDisposition(filename)),
	}
	result, err := r.signer.PresignGetObject(ctx, input, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil {
		return "", err
	}
	return result.URL, nil
}

func (r *r2Storage) Head(ctx context.Context, id string) (exportObject, error) {
	result, err := r.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(r.bucket), Key: aws.String(id), ChecksumMode: "ENABLED"})
	if err != nil {
		return exportObject{}, err
	}
	object := exportObject{ContentType: aws.ToString(result.ContentType), Size: aws.ToInt64(result.ContentLength)}
	if result.ChecksumSHA256 != nil {
		object.SHA256 = aws.ToString(result.ChecksumSHA256)
	}
	return object, nil
}

func exportDisposition(filename string) string {
	return mime.FormatMediaType("attachment", map[string]string{"filename": filename})
}
